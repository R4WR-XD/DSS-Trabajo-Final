"""Importa porcentajes de población en edad escolar desde el CSV censal.

Uso desde la raíz del repositorio:
    python -m backend.scripts.importar_porcentaje_edad_escolar

También se puede indicar otra ruta al CSV como primer argumento.
"""

import argparse
import csv
from pathlib import Path
from typing import Iterator

from sqlalchemy.dialects.postgresql import insert

from ..database import Base, engine
from ..models import SchoolAgePercentage


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CSV = PROJECT_ROOT / "pdfcensal" / "porcentaje_poblacion_edad_escolar.csv"
EXPECTED_HEADERS = ["provincia", "departamento", "sexo", "porcentaje_edad_escolar"]
KEY_COLUMNS = [
    SchoolAgePercentage.provincia,
    SchoolAgePercentage.departamento,
    SchoolAgePercentage.sexo,
]
BATCH_SIZE = 1000
ALLOWED_SEXES = {"Ambos sexos", "Mujeres"}


def read_batches(csv_path: Path, batch_size: int = BATCH_SIZE) -> Iterator[list[dict]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != EXPECTED_HEADERS:
            raise ValueError(
                "Encabezados CSV inválidos. Se esperaban, en este orden: "
                + ", ".join(EXPECTED_HEADERS)
            )

        batch: list[dict] = []
        for row_number, row in enumerate(reader, start=2):
            try:
                provincia = (row["provincia"] or "").strip()
                departamento = (row["departamento"] or "").strip()
                sexo = (row["sexo"] or "").strip()
                porcentaje = float(row["porcentaje_edad_escolar"])
            except (TypeError, ValueError) as error:
                raise ValueError(f"Datos inválidos en la fila {row_number}.") from error

            if not provincia or not departamento:
                raise ValueError(f"Provincia o departamento vacío en la fila {row_number}.")
            if sexo not in ALLOWED_SEXES:
                raise ValueError(
                    f"Sexo no válido en la fila {row_number}: {sexo!r}. "
                    f"Se esperaba uno de {sorted(ALLOWED_SEXES)}."
                )
            if not 0 <= porcentaje <= 100:
                raise ValueError(
                    f"Porcentaje fuera del rango 0-100 en la fila {row_number}."
                )

            batch.append(
                {
                    "provincia": provincia,
                    "departamento": departamento,
                    "sexo": sexo,
                    "porcentaje_edad_escolar": porcentaje,
                }
            )
            if len(batch) >= batch_size:
                yield batch
                batch = []

        if batch:
            yield batch


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Importa el porcentaje de población en edad escolar a PostgreSQL."
    )
    parser.add_argument(
        "csv_path",
        nargs="?",
        type=Path,
        default=DEFAULT_CSV,
        help=f"Ruta del CSV (predeterminada: {DEFAULT_CSV})",
    )
    args = parser.parse_args()
    csv_path = args.csv_path.expanduser().resolve()
    if not csv_path.is_file():
        parser.error(f"No se encontró el archivo: {csv_path}")

    # El modelo crea la tabla si todavía no existe; la migración SQL queda disponible
    # para instalaciones que administran el esquema de forma explícita.
    Base.metadata.create_all(bind=engine)

    total = 0
    with engine.begin() as connection:
        for batch in read_batches(csv_path):
            statement = insert(SchoolAgePercentage).values(batch)
            statement = statement.on_conflict_do_update(
                index_elements=KEY_COLUMNS,
                set_={
                    "porcentaje_edad_escolar": statement.excluded.porcentaje_edad_escolar
                },
            )
            connection.execute(statement)
            total += len(batch)

    print(f"Importación completa: {total:,} filas procesadas desde {csv_path}.")


if __name__ == "__main__":
    main()
