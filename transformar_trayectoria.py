#!/usr/bin/env python3
"""
Transforma archivos de trayectoria educativa (CSV o Excel) a formatos más útiles
para un DSS temporal.

Salidas:
  1. observaciones_largas.csv:
     una fila por combinación de año, territorio, dimensiones y variable.
  2. indicadores.csv:
     una fila por territorio y año de estudio, con indicadores derivados.
  3. informe_validacion.txt:
     resumen de archivos, columnas y advertencias.

Uso:
  python transformar_trayectoria.py trayectoria_2025.csv --year 2025 --out datos_procesados
  python transformar_trayectoria.py trayectoria_2024.xlsx --year 2024 --out datos_procesados

Dependencias:
  pip install pandas openpyxl
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Optional

import pandas as pd


# Variables que se esperan en el archivo de trayectoria.
DIMENSION_COLUMNS = ["provincia", "departamento", "sector", "ambito"]

# El orden importa: primero se intentan reconocer los prefijos más largos.
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

# Sufijos observados en el CSV compartido. Se conservan como categorías,
# sin asumir que todos son años de estudio numéricos.
STUDY_SUFFIXES = {"1314": "13-14", "20": "20"}
FEMALE_PREFIX = "m_"


def read_table(path: Path, sheet: Optional[str] = None) -> pd.DataFrame:
    """Lee CSV o Excel e intenta manejar codificaciones y separadores comunes."""
    suffix = path.suffix.lower()

    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path, sheet_name=sheet if sheet else 0, dtype=object)

    if suffix in {".csv", ".txt"}:
        errors = []
        for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin1"):
            try:
                # sep=None permite que pandas detecte coma, punto y coma o tabulación.
                return pd.read_csv(
                    path,
                    sep=None,
                    engine="python",
                    encoding=encoding,
                    dtype=object,
                    keep_default_na=True,
                )
            except Exception as exc:
                errors.append(f"{encoding}: {exc}")
        raise ValueError("No se pudo leer el CSV. " + " | ".join(errors))

    raise ValueError(f"Formato no soportado: {suffix}. Usá CSV, XLSX o XLS.")


def clean_column_names(df: pd.DataFrame) -> pd.DataFrame:
    """Normaliza espacios en los encabezados sin cambiar sus nombres semánticos."""
    df = df.copy()
    df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
    return df


def normalize_text_columns(df: pd.DataFrame) -> pd.DataFrame:
    for col in DIMENSION_COLUMNS:
        if col in df.columns:
            df[col] = df[col].map(
                lambda x: x.strip() if isinstance(x, str) else x
            )
            df[col] = df[col].replace("", pd.NA)
    return df


def numeric_value(value):
    """Convierte valores numéricos; conserva vacíos como NaN."""
    if pd.isna(value):
        return pd.NA
    if isinstance(value, str):
        value = value.strip()
        if value == "":
            return pd.NA
        # En caso de decimales con coma, se admite solo si no hay punto.
        if "," in value and "." not in value:
            value = value.replace(",", ".")
    try:
        number = float(value)
        if number.is_integer():
            return int(number)
        return number
    except (TypeError, ValueError):
        return pd.NA


def parse_variable(column: str):
    """
    Devuelve (indicador, sexo, año_estudio) o None.
    Ejemplos:
      m_nopromo_3 -> (nopromo, mujeres, 3)
      ssp_1314 -> (ssp, total, 13-14)
      primaria_egresados -> (primaria_egresados, total, no_aplica)
    """
    name = str(column).strip()
    sex = "mujeres" if name.startswith(FEMALE_PREFIX) else "total"
    base = name[len(FEMALE_PREFIX):] if sex == "mujeres" else name

    # Variables agregadas sin sufijo de año de estudio.
    if base in {
        "primaria_egresados",
        "secundaria_egresados",
        "primaria_m_egresados",
        "secundaria_m_egresados",
    }:
        # Los encabezados primaria_m_egresados/secundaria_m_egresados ya
        # incorporan el desglose por sexo en el nombre.
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


def add_year_of_study_group(study_year):
    """Agrupación opcional para facilitar filtros; no infiere nivel oficial."""
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


def transform_long(df: pd.DataFrame, year: int):
    df = clean_column_names(df)
    df = normalize_text_columns(df)

    missing_dims = [c for c in DIMENSION_COLUMNS if c not in df.columns]
    if missing_dims:
        raise ValueError(
            "Faltan columnas territoriales esperadas: "
            + ", ".join(missing_dims)
            + ". Revisá si el archivo tiene otro formato."
        )

    id_cols = DIMENSION_COLUMNS.copy()
    # No agregamos columnas de sexo/ámbito nuevas si no existen en el origen.
    variable_cols = [c for c in df.columns if c not in id_cols]

    records = []
    unrecognized = []
    for col in variable_cols:
        parsed = parse_variable(col)
        if parsed is None:
            unrecognized.append(col)
            continue
        indicator, sex, study_year = parsed
        vals = df[col].map(numeric_value)
        part = df[id_cols].copy()
        part["year"] = int(year)
        part["study_year"] = study_year
        part["study_year_group"] = add_year_of_study_group(study_year)
        part["indicator"] = indicator
        part["sex"] = sex
        part["value"] = vals
        part["source_column"] = col
        records.append(part)

    if records:
        long_df = pd.concat(records, ignore_index=True)
    else:
        long_df = pd.DataFrame(
            columns=id_cols + [
                "year", "study_year", "study_year_group", "indicator",
                "sex", "value", "source_column"
            ]
        )

    # Retira observaciones completamente vacías, pero conserva ceros.
    if not long_df.empty:
        long_df = long_df[long_df["value"].notna()].copy()

    return long_df, missing_dims, unrecognized


def safe_divide(numerator, denominator):
    numerator = pd.to_numeric(numerator, errors="coerce")
    denominator = pd.to_numeric(denominator, errors="coerce")
    result = numerator / denominator * 100
    return result.where(denominator > 0)


def make_indicators(long_df: pd.DataFrame) -> pd.DataFrame:
    """Construye indicadores exploratorios a partir de valores totales."""
    if long_df.empty:
        return pd.DataFrame()

    # Para evitar mezclar el total con el desglose por mujeres.
    base = long_df[long_df["sex"] == "total"].copy()
    if base.empty:
        return pd.DataFrame()

    keys = [
        "year", "provincia", "departamento", "sector", "ambito", "study_year"
    ]
    wide = base.pivot_table(
        index=keys,
        columns="indicator",
        values="value",
        aggfunc="first",
        dropna=True,
    ).reset_index()
    wide.columns.name = None

    # Indicadores exploratorios, no sustituyen necesariamente las tasas oficiales.
    if {"promovidos", "nopromo"}.issubset(wide.columns):
        denominator = wide["promovidos"] + wide["nopromo"]
        wide["tasa_no_promocion_pct"] = safe_divide(wide["nopromo"], denominator)
        wide["tasa_promocion_sobre_promovidos_nopromo_pct"] = safe_divide(
            wide["promovidos"], denominator
        )

    if {"ssp", "inicial"}.issubset(wide.columns):
        # Solo una razón exploratoria: validar el denominador antes de usarla
        # como indicador oficial de abandono/desvinculación.
        wide["salidas_sin_pase_sobre_matricula_inicial_pct"] = safe_divide(
            wide["ssp"], wide["inicial"]
        )

    if {"ultimo", "inicial"}.issubset(wide.columns):
        wide["variacion_matricula_inicial_a_ultimo_pct"] = (
            (pd.to_numeric(wide["ultimo"], errors="coerce")
             - pd.to_numeric(wide["inicial"], errors="coerce"))
            / pd.to_numeric(wide["inicial"], errors="coerce")
            * 100
        ).where(pd.to_numeric(wide["inicial"], errors="coerce") > 0)

    return wide


def main():
    parser = argparse.ArgumentParser(
        description="Transforma archivos de trayectoria educativa a formato largo."
    )
    parser.add_argument("input", help="Ruta al CSV, XLSX o XLS de origen.")
    parser.add_argument(
        "--year", type=int, required=True,
        help="Año de referencia del archivo, por ejemplo 2025."
    )
    parser.add_argument(
        "--out", default="datos_procesados",
        help="Carpeta de salida (por defecto: datos_procesados)."
    )
    parser.add_argument(
        "--sheet", default=None,
        help="Nombre de hoja Excel opcional; por defecto se lee la primera."
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        print(f"ERROR: no existe el archivo: {input_path}", file=sys.stderr)
        sys.exit(2)

    try:
        original = read_table(input_path, sheet=args.sheet)
        original = clean_column_names(original)
        long_df, missing_dims, unrecognized = transform_long(original, args.year)
        indicators = make_indicators(long_df)

        long_path = out_dir / f"observaciones_largas_{args.year}.csv"
        indicators_path = out_dir / f"indicadores_{args.year}.csv"
        report_path = out_dir / f"informe_validacion_{args.year}.txt"

        long_df.to_csv(long_path, index=False, encoding="utf-8-sig")
        indicators.to_csv(indicators_path, index=False, encoding="utf-8-sig")

        report = [
            f"Archivo de origen: {input_path}",
            f"Año asignado: {args.year}",
            f"Filas de origen: {len(original)}",
            f"Columnas de origen: {len(original.columns)}",
            f"Filas en formato largo: {len(long_df)}",
            f"Filas de indicadores: {len(indicators)}",
            f"Columnas territoriales faltantes: {missing_dims or 'ninguna'}",
            "",
            "Columnas no reconocidas (no se transformaron):",
            *(unrecognized if unrecognized else ["ninguna"]),
            "",
            "Advertencias metodológicas:",
            "- El sufijo 1314 se conserva como categoría '13-14'; no se convierte a un año numérico.",
            "- El sufijo 20 se conserva como categoría '20'; verificar su significado en la documentación de origen.",
            "- La agrupación de años de estudio es técnica y no confirma por sí misma nivel educativo.",
            "- tasa_no_promocion_pct usa nopromo / (promovidos + nopromo); validar que las categorías y el denominador sean apropiados para cada edición.",
            "- salidas_sin_pase_sobre_matricula_inicial_pct es exploratorio y NO debe presentarse como tasa oficial de abandono sin validación.",
            "- Los registros se mantienen al nivel territorial presente en el CSV; no representan escuelas individuales salvo que la fuente realmente lo haga.",
            "- Para comparar años, comprobar que definiciones, categorías y granularidad sean compatibles.",
        ]
        report_path.write_text("\n".join(report), encoding="utf-8")

        print("Transformación terminada.")
        print(f"Formato largo: {long_path}")
        print(f"Indicadores:    {indicators_path}")
        print(f"Informe:        {report_path}")
        print("Revisá el informe antes de utilizar los indicadores para priorización.")

    except Exception as exc:
        print(f"ERROR durante la transformación: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
