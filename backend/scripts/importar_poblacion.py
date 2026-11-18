"""Importa estimaciones de población desde el CSV censal del proyecto.

Uso desde la raíz del repositorio:
    python -m backend.scripts.importar_poblacion

También se puede indicar otra ruta al CSV como primer argumento.
"""

import argparse
import csv
from pathlib import Path
from typing import Iterator

from sqlalchemy.dialects.postgresql import insert

from ..database import Base, engine
from ..models import PopulationEstimate


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CSV = PROJECT_ROOT / "pdfcensal" / "poblacion_provincia_departamento_sexo_anio.csv"
EXPECTED_HEADERS = {"provincia", "departamento", "sexo", "año", "poblacion"}
KEY_COLUMNS = [
    PopulationEstimate.provincia,
    PopulationEstimate.departamento,
    PopulationEstimate.sexo,
    PopulationEstimate.year,
]
BATCH_SIZE = 1000


def read_batches(csv_path: Path, batch_size: int = BATCH_SIZE) -> Iterator[list[dict]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        headers = set(reader.fieldnames or [])
        if headers != EXPECTED_HEADERS:
            missing = sorted(EXPECTED_HEADERS - headers)
            unexpected = sorted(headers - EXPECTED_HEADERS)
            raise ValueError(
                f"Encabezados CSV inválidos. Faltan: {missing}; sobran: {unexpected}."
            )

        batch: list[dict] = []
        for row_number, row in enumerate(reader, start=2):
            try:
                provincia = (row["provincia"] or "").strip()
                departamento = (row["departamento"] or "").strip()
                sexo = (row["sexo"] or "").strip()
                year = int(row["año"])
                poblacion = int(row["poblacion"])
            except (TypeError, ValueError) as error:
                raise ValueError(f"Datos inválidos en la fila {row_number}.") from error

            if not provincia or not departamento or not sexo:
                raise ValueError(f"Hay dimensiones vacías en la fila {row_number}.")
            if year < 1900 or year > 2100 or poblacion < 0:
                raise ValueError(f"Año o población fuera de rango en la fila {row_number}.")

            batch.append(
                {
                    "provincia": provincia,
                    "departamento": departamento,
                    "sexo": sexo,
                    "year": year,
                    "poblacion": poblacion,
                }
            )
            if len(batch) >= batch_size:
                yield batch
                batch = []

        if batch:
            yield batch


def main() -> None:
    parser = argparse.ArgumentParser(description="Importa la población censal a PostgreSQL.")
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

    # Crea la nueva tabla en bases existentes; no altera las tablas actuales.
    Base.metadata.create_all(bind=engine)

    total = 0
    with engine.begin() as connection:
        for batch in read_batches(csv_path):
            statement = insert(PopulationEstimate).values(batch)
            statement = statement.on_conflict_do_update(
                index_elements=KEY_COLUMNS,
                set_={"poblacion": statement.excluded.poblacion},
            )
            connection.execute(statement)
            total += len(batch)

    print(f"Importación completa: {total:,} filas procesadas desde {csv_path}.")


if __name__ == "__main__":
    main()
