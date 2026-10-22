"""
Procesamiento reutilizable de datos de trayectoria educativa para el backend del DSS.

Instalación:
    pip install pandas openpyxl pydantic

Uso:
    from procesador_trayectoria import procesar_trayectoria, procesar_archivo

    observaciones = procesar_trayectoria(df, year=2025)
    # o bien:
    observaciones = procesar_archivo("trayectoria_2025.csv", year=2025)

Ambas funciones devuelven list[ProcessedObservation].
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field


DIMENSION_COLUMNS = ["provincia", "departamento", "sector", "ambito"]
INDICATOR_PREFIXES = [
    "promovidos_mas_2mat",
    "promovidos_ex",
    "primaria_m_egresados",
    "secundaria_m_egresados",
    "primaria_egresados",
    "secundaria_egresados",
    "promovidos",
    "nopromo",
    "regulares",
    "entrados",
    "inicial",
    "scp",
    "ssp",
    "ultimo",
    "otros",
]
STUDY_SUFFIXES = {"1314": "13-14", "20": "20"}
FEMALE_PREFIX = "m_"


class ProcessedObservation(BaseModel):
    """Una observación procesada lista para validar, persistir o devolver desde la API."""

    model_config = ConfigDict(extra="forbid")

    year: int = Field(ge=1900, le=2100, description="Año del dataset de origen")
    provincia: str = Field(min_length=1)
    departamento: str = Field(min_length=1)
    sector: str | None = None
    ambito: str | None = None
    study_year: str
    study_year_group: str
    indicator: str
    sex: Literal["total", "mujeres"]
    value: float
    source_column: str


def _read_file(path: str | Path, sheet: str | int | None = None) -> pd.DataFrame:
    """Lee CSV o Excel. La función pública acepta también un DataFrame directamente."""
    file_path = Path(path)
    suffix = file_path.suffix.lower()

    if suffix in {".xlsx", ".xls"}:
        result = pd.read_excel(file_path, sheet_name=sheet if sheet is not None else 0, dtype=object)
        if not isinstance(result, pd.DataFrame):
            raise ValueError("La hoja indicada no produjo una tabla.")
        return result

    if suffix in {".csv", ".txt"}:
        errors = []
        for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin1"):
            try:
                return pd.read_csv(
                    file_path, sep=None, engine="python",
                    encoding=encoding, dtype=object, keep_default_na=True,
                )
            except Exception as exc:
                errors.append(f"{encoding}: {exc}")
        raise ValueError("No se pudo leer el CSV. " + " | ".join(errors))

    raise ValueError(f"Formato no soportado: {suffix}. Usá CSV, XLSX o XLS.")


def _normalize_text(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
    for col in DIMENSION_COLUMNS:
        if col in df.columns:
            df[col] = df[col].map(lambda x: x.strip() if isinstance(x, str) else x)
            df[col] = df[col].replace("", pd.NA)
    return df


def _numeric_value(value):
    if pd.isna(value):
        return None
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        if "," in value and "." not in value:
            value = value.replace(",", ".")
    try:
        number = float(value)
        return int(number) if number.is_integer() else number
    except (TypeError, ValueError):
        return None


def _parse_variable(column: str):
    name = str(column).strip()
    sex = "mujeres" if name.startswith(FEMALE_PREFIX) else "total"
    base = name[len(FEMALE_PREFIX):] if sex == "mujeres" else name

    if base in {
        "primaria_egresados", "secundaria_egresados",
        "primaria_m_egresados", "secundaria_m_egresados",
    }:
        if base.endswith("_m_egresados"):
            return (base.replace("_m_egresados", "_egresados"), "mujeres", "no_aplica")
        return (base, sex, "no_aplica")

    for prefix in INDICATOR_PREFIXES:
        if base.startswith(prefix + "_"):
            suffix = base[len(prefix) + 1:]
            if suffix in STUDY_SUFFIXES:
                study_year = STUDY_SUFFIXES[suffix]
            elif suffix.isdigit():
                study_year = suffix
            else:
                continue
            return (prefix, sex, study_year)
    return None


def _study_year_group(study_year: str) -> str:
    if study_year in {"no_aplica", "13-14", "20"}:
        return "categoría_especial"
    try:
        n = int(study_year)
    except (TypeError, ValueError):
        return "sin_clasificar"
    if 1 <= n <= 6:
        return "años_1_a_6"
    if 7 <= n <= 12:
        return "años_7_a_12"
    return "sin_clasificar"


def procesar_trayectoria(
    data: pd.DataFrame,
    year: int,
) -> list[ProcessedObservation]:
    """
    Transforma un DataFrame de trayectoria en observaciones validadas.

    No escribe archivos ni interactúa con la base de datos. Eso permite llamarla
    desde un endpoint de FastAPI o desde un servicio de importación.

    Las columnas que no se reconocen se omiten; los valores vacíos/no numéricos
    también se omiten. Las columnas territoriales requeridas deben estar presentes.
    """
    if not 1900 <= int(year) <= 2100:
        raise ValueError("El año debe estar entre 1900 y 2100.")

    df = _normalize_text(data)
    missing_dims = [col for col in DIMENSION_COLUMNS if col not in df.columns]
    if missing_dims:
        raise ValueError(
            "Faltan columnas territoriales requeridas: " + ", ".join(missing_dims)
        )

    observations: list[ProcessedObservation] = []

    for _, row in df.iterrows():
        # Evita crear observaciones sin ubicación territorial mínima.
        provincia = row.get("provincia")
        departamento = row.get("departamento")
        if pd.isna(provincia) or pd.isna(departamento):
            continue

        for column in df.columns:
            if column in DIMENSION_COLUMNS:
                continue

            parsed = _parse_variable(column)
            if parsed is None:
                continue

            indicator, sex, study_year = parsed
            value = _numeric_value(row[column])
            if value is None:
                continue

            sector = row.get("sector")
            ambito = row.get("ambito")

            observations.append(
                ProcessedObservation(
                    year=int(year),
                    provincia=str(provincia),
                    departamento=str(departamento),
                    sector=None if pd.isna(sector) else str(sector),
                    ambito=None if pd.isna(ambito) else str(ambito),
                    study_year=study_year,
                    study_year_group=_study_year_group(study_year),
                    indicator=indicator,
                    sex=sex,
                    value=float(value),
                    source_column=str(column),
                )
            )

    return observations


def procesar_archivo(
    path: str | Path,
    year: int,
    sheet: str | int | None = None,
) -> list[ProcessedObservation]:
    """Conveniencia para el backend: lee el archivo y devuelve los mismos objetos."""
    df = _read_file(path, sheet=sheet)
    return procesar_trayectoria(df, year=year)
