"""Calcula porcentajes de población de 4 a 17 años desde cuadros XLSX del Censo 2022.

Colocar los XLSX descargados por jurisdicción en ``pdfcensal/edad_escolar`` y ejecutar
desde la raíz del repositorio:

    python -m backend.scripts.calcular_porcentaje_edad_escolar

Se puede pasar una carpeta de entrada, una salida y otro rango de edad como argumentos.
"""

import argparse
import csv
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

from openpyxl import load_workbook


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT_DIR = PROJECT_ROOT / "pdfcensal" / "edad_escolar"
DEFAULT_OUTPUT = PROJECT_ROOT / "pdfcensal" / "porcentaje_poblacion_edad_escolar.csv"

PROVINCES = [
    "Ciudad Autónoma de Buenos Aires", "Buenos Aires", "Catamarca", "Chaco", "Chubut",
    "Córdoba", "Corrientes", "Entre Ríos", "Formosa", "Jujuy", "La Pampa", "La Rioja",
    "Mendoza", "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis",
    "Santa Cruz", "Santa Fe", "Santiago del Estero",
    "Tierra del Fuego, Antártida e Islas del Atlántico Sur", "Tucumán",
]


def normalize(value: Any) -> str:
    text = "" if value is None else str(value)
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def province_from_file(path: Path) -> str:
    source = normalize(path.stem)
    aliases = {
        "ciudad autonoma de buenos aires": "Ciudad Autónoma de Buenos Aires",
        "capital federal": "Ciudad Autónoma de Buenos Aires",
        "caba": "Ciudad Autónoma de Buenos Aires",
        "buenos aires": "Buenos Aires",
        "bsas": "Buenos Aires",
        "bs as": "Buenos Aires",
        "tdf": "Tierra del Fuego, Antártida e Islas del Atlántico Sur",
        "tierra del fuego": "Tierra del Fuego, Antártida e Islas del Atlántico Sur",
        "santiago est": "Santiago del Estero",
    }
    # Prefer the longer names so "Buenos Aires" inside the CABA name is not selected.
    for alias in sorted(aliases, key=len, reverse=True):
        if alias in source:
            return aliases[alias]
    compact_source = source.replace(" ", "")
    for province in sorted(PROVINCES, key=len, reverse=True):
        key = normalize(province)
        # INDEC names files like ``c2022_sanluis_est_c6_19.xlsx`` without spaces.
        if key in source or key.replace(" ", "") in compact_source:
            return province
    raise ValueError(
        f"No pude reconocer la jurisdicción en el nombre '{path.name}'. "
        "Renombrá el archivo para incluir el nombre de la provincia o CABA."
    )


def numeric(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("\u00a0", "")
    if not text or text in {"-", "///"}:
        return None
    text = text.replace(" ", "")
    # Excel cells are normally numeric; this also accepts formatted strings such as 1.234.
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        text = text.replace(".", "")
    elif "," in text and "." not in text:
        text = text.replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def parse_age(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    text = normalize(value)
    match = re.fullmatch(r"(\d{1,3})(?: anos?)?", text)
    return int(match.group(1)) if match else None


def is_all_ages(value: Any) -> bool:
    return normalize(value) in {"total", "todas las edades", "total edades"}


def is_total_label(value: Any) -> bool:
    return normalize(value) in {"total", "total poblacion", "total de poblacion"}


def combined_headers(rows: list[tuple[Any, ...]], header_row: int) -> list[str]:
    """Join up to two heading rows, including merged group headings like Sexo."""
    width = max((len(row) for row in rows[header_row:header_row + 3]), default=0)
    result = []
    for col in range(width):
        parts = []
        for row in rows[header_row:header_row + 3]:
            value = row[col] if col < len(row) else None
            if value is not None and str(value).strip():
                parts.append(normalize(value))
        result.append(" ".join(parts))
    return result


def locate_columns(rows: list[tuple[Any, ...]]) -> tuple[int, dict[str, int]] | None:
    for row_index in range(min(20, len(rows))):
        headers = combined_headers(rows, row_index)
        dept_col = next(
            (i for i, header in enumerate(headers)
             if any(word in header for word in ("departamento", "partido", "comuna"))),
            None,
        )
        age_col = next((i for i, header in enumerate(headers) if "edad" in header), None)
        if dept_col is None or age_col is None:
            continue

        columns: dict[str, int] = {"department": dept_col, "age": age_col}
        for i, header in enumerate(headers):
            if any(word in header for word in ("mujer", "femenino")):
                columns.setdefault("women", i)
            if any(word in header for word in ("varon", "masculino", "hombre")):
                columns.setdefault("men", i)
            if "sexo" in header and not any(word in header for word in ("mujer", "femenino", "varon", "masculino")):
                columns.setdefault("sex", i)
            if "poblacion" in header and "indice" not in header:
                # The general total column is preferred to sex-specific columns.
                if "total" in header or "ambos sexos" in header:
                    columns.setdefault("total", i)
                elif "sex" not in columns:
                    columns.setdefault("total", i)
        if "women" in columns and "total" in columns:
            return row_index, columns
        if "sex" in columns and "total" in columns:
            return row_index, columns
    return None


def read_sheet(
    rows: list[tuple[Any, ...]],
    province: str,
    age_min: int,
    age_max: int,
    source_name: str,
    sheet_name: str,
) -> dict[tuple[str, str], dict[str, float]] | None:
    located = locate_columns(rows)
    if located is None:
        return None
    header_row, columns = located
    result: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    current_department = ""

    for row in rows[header_row + 1:]:
        if not row:
            continue
        dept_value = row[columns["department"]] if columns["department"] < len(row) else None
        if dept_value is not None and str(dept_value).strip():
            department_text = str(dept_value).strip()
            if not is_total_label(department_text):
                current_department = department_text
            elif is_total_label(department_text):
                # Rows with a department-level total usually have no age value, so
                # don't let the label replace the current department.
                pass
        if not current_department:
            continue

        age_value = row[columns["age"]] if columns["age"] < len(row) else None
        age = parse_age(age_value)
        total = numeric(row[columns["total"]] if columns["total"] < len(row) else None)
        if total is None:
            continue

        if "sex" in columns:
            sex_value = row[columns["sex"]] if columns["sex"] < len(row) else None
            sex_key = normalize(sex_value)
            bucket = "women" if "mujer" in sex_key or "femenino" in sex_key else (
                "both" if "ambos" in sex_key or sex_key == "total" else "men"
            )
            stats = result[(province, current_department)]
            if is_all_ages(age_value):
                stats[f"denom_{bucket}"] = total
            elif age is not None:
                stats[f"all_{bucket}"] += total
            if age is not None and age_min <= age <= age_max:
                result[(province, current_department)][f"school_{bucket}"] += total
        else:
            women = numeric(row[columns["women"]] if columns["women"] < len(row) else None)
            if women is None:
                continue
            stats = result[(province, current_department)]
            if is_all_ages(age_value):
                stats["denom_both"] = total
                stats["denom_women"] = women
            elif age is not None:
                stats["all_both"] += total
                stats["all_women"] += women
            if age is not None and age_min <= age <= age_max:
                stats["school_both"] += total
                stats["school_women"] += women

    return result if result else None


def territory_from_sheet(rows: list[tuple[Any, ...]]) -> str | None:
    """Extracts the department/party/comuna named in the table title."""
    for row in rows[:5]:
        for value in row:
            if not isinstance(value, str):
                continue
            title = re.sub(r"\s+", " ", value.replace("\u00a0", " ")).strip()
            match = re.search(
                r"\b(?:departamento|partido|comuna)\s+(.+?)(?:\.\s*total de poblaci[oó]n|\s*$)",
                title,
                flags=re.IGNORECASE,
            )
            if match:
                return match.group(1).strip(" .")
    return None


def read_censo_territory_sheet(
    rows: list[tuple[Any, ...]], province: str, age_min: int, age_max: int
) -> dict[tuple[str, str], dict[str, float]] | None:
    """Reads an INDEC Cuadro 4.2 worksheet, which contains one territory per sheet."""
    department = territory_from_sheet(rows)
    if department is None:
        # Cuadro 4.2.0 is the provincial total, not a department-level record.
        return None

    header_row = None
    for row_index, row in enumerate(rows[:15]):
        labels = [normalize(value) for value in row]
        if "edad" in labels and any("total de poblacion" in label for label in labels):
            header_row = row_index
            break
    if header_row is None or header_row + 1 >= len(rows):
        return None

    headers = [normalize(value) for value in rows[header_row]]
    total_col = next((i for i, label in enumerate(headers) if "total de poblacion" in label), None)
    age_col = next((i for i, label in enumerate(headers) if label == "edad"), None)
    subheaders = [normalize(value) for value in rows[header_row + 1]]
    women_col = next(
        (i for i, label in enumerate(subheaders) if "mujer" in label or "femenino" in label),
        None,
    )
    if total_col is None or age_col is None or women_col is None:
        return None

    stats: dict[str, float] = defaultdict(float)
    for row in rows[header_row + 2:]:
        age_value = row[age_col] if age_col < len(row) else None
        total = numeric(row[total_col] if total_col < len(row) else None)
        women = numeric(row[women_col] if women_col < len(row) else None)
        if total is None or women is None:
            continue
        if is_all_ages(age_value):
            stats["denom_both"] = total
            stats["denom_women"] = women
            continue
        age = parse_age(age_value)
        if age is not None and age_min <= age <= age_max:
            stats["school_both"] += total
            stats["school_women"] += women

    if not stats:
        return None
    return {(province, department): stats}


def process_workbook(path: Path, age_min: int, age_max: int) -> dict[tuple[str, str], dict[str, float]]:
    province = province_from_file(path)
    workbook = load_workbook(path, data_only=True, read_only=True)
    merged: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    parsed_sheet = False
    try:
        for worksheet in workbook.worksheets:
            rows = list(worksheet.iter_rows(values_only=True))
            parsed = read_censo_territory_sheet(rows, province, age_min, age_max)
            if parsed is None:
                continue
            parsed_sheet = True
            for key, stats in parsed.items():
                for metric, value in stats.items():
                    merged[key][metric] += value
    finally:
        workbook.close()
    if not parsed_sheet or not merged:
        raise ValueError(
            f"No encontré una tabla de edad y departamento/partido/comuna en {path.name}. "
            "Revisá que sea el cuadro de población por edad, sexo y departamento."
        )
    return merged


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Calcula el porcentaje de población de edad escolar por territorio y sexo."
    )
    parser.add_argument("input_dir", nargs="?", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--edad-min", type=int, default=4)
    parser.add_argument("--edad-max", type=int, default=17)
    args = parser.parse_args()

    input_dir = args.input_dir.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if args.edad_min < 0 or args.edad_max < args.edad_min:
        parser.error("El rango de edad debe ser válido y no negativo.")
    if not input_dir.is_dir():
        parser.error(f"No existe la carpeta de entrada: {input_dir}")

    files = sorted(path for path in input_dir.glob("*.xlsx") if not path.name.startswith("~$"))
    if not files:
        parser.error(f"No encontré archivos .xlsx en {input_dir}")

    totals: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    errors = []
    for path in files:
        try:
            workbook_data = process_workbook(path, args.edad_min, args.edad_max)
            for key, stats in workbook_data.items():
                for metric, value in stats.items():
                    totals[key][metric] += value
        except (OSError, ValueError, KeyError) as error:
            errors.append(f"{path.name}: {error}")

    if errors:
        parser.error("No se pudieron procesar todos los archivos:\n- " + "\n- ".join(errors))

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8-sig", newline="") as destination:
        writer = csv.writer(destination)
        writer.writerow(["provincia", "departamento", "sexo", "porcentaje_edad_escolar"])
        for (province, department), stats in sorted(totals.items()):
            both_total = stats.get("denom_both", stats.get("all_both", stats.get("all_women", 0) + stats.get("all_men", 0)))
            both_school = stats.get("school_both", stats.get("school_women", 0) + stats.get("school_men", 0))
            women_total = stats.get("denom_women", stats.get("all_women", 0))
            women_school = stats.get("school_women", 0)
            for sex, numerator, denominator in (
                ("Ambos sexos", both_school, both_total),
                ("Mujeres", women_school, women_total),
            ):
                if denominator <= 0:
                    raise ValueError(f"Población total inválida para {province} / {department} / {sex}.")
                writer.writerow([province, department, sex, round(numerator / denominator * 100, 6)])

    print(
        f"CSV creado: {output} ({len(totals)} territorios, {len(totals) * 2} filas; "
        f"edades {args.edad_min}-{args.edad_max})."
    )


if __name__ == "__main__":
    main()
