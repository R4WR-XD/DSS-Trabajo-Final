"""API de carga para el DSS de trayectorias educativas."""

from pathlib import Path
import re
from tempfile import NamedTemporaryFile
import unicodedata

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session
from statsmodels.tsa.holtwinters import Holt

from . import models
from .database import Base, engine, get_db
from .models import ImportBatch, Observation, PopulationEstimate, SchoolAgePercentage
from .schemas import UploadResponse
from .scripts.procesador_trayectoria import procesar_archivo

Base.metadata.create_all(bind=engine)

app = FastAPI(title="DSS Educación API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_EXTENSIONS = {".csv", ".txt", ".xlsx", ".xls"}


def province_key(name: str) -> str:
    normalized = unicodedata.normalize("NFD", name.lower())
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized).strip()
    if normalized in {
        "caba",
        "capital federal",
        "ciudad de buenos aires",
        "ciudad autonoma buenos aires",
        "ciudad autonoma de buenos aires",
    }:
        return "ciudad autonoma de buenos aires"
    if normalized.startswith("tierra del fuego"):
        return "tierra del fuego"
    return normalized


def department_key(name: str) -> str:
    normalized = unicodedata.normalize("NFD", name.lower())
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized).strip()
    # Censo 2022 and the annual estimates use a few different labels for the
    # same territory. Comuna sheets contain just the number in their title.
    aliases = {
        **{str(number): f"comuna {number}" for number in range(1, 16)},
        "angel vicente penaloza": "general angel v penaloza",
        "coronel felipe varela": "general felipe varela",
        "general juan f quiroga": "general juan facundo quiroga",
        "general ocampo": "general ortiz de ocampo",
        "la capital": "juan martin de pueyrredon",
        "juan f ibarra": "juan felipe ibarra",
        "juan b alberdi": "juan bautista alberdi",
    }
    return aliases.get(normalized, normalized)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/statistics/years")
def statistics_years(db: Session = Depends(get_db)):
    """Años cargados, mostrando la importación más reciente de cada uno."""
    latest_ids = (
        db.query(func.max(ImportBatch.id).label("id"))
        .group_by(ImportBatch.year)
        .subquery()
    )
    batches = (
        db.query(ImportBatch)
        .join(latest_ids, ImportBatch.id == latest_ids.c.id)
        .order_by(ImportBatch.year.desc())
        .all()
    )
    return [
        {"year": batch.year, "import_id": batch.id, "file_name": batch.file_name}
        for batch in batches
    ]


@app.get("/api/predictions")
def prediction(
    year: int,
    province: str | None = None,
    db: Session = Depends(get_db),
):
    """Pronostica la tasa de no promoción para un año usando solo años anteriores."""
    if not 1900 <= year <= 2100:
        raise HTTPException(422, "El año debe estar entre 1900 y 2100.")

    latest_ids = db.query(func.max(ImportBatch.id).label("id")).group_by(ImportBatch.year).subquery()
    batches = db.query(ImportBatch).join(latest_ids, ImportBatch.id == latest_ids.c.id).all()
    batch_by_year = {batch.year: batch for batch in batches if batch.year < year}
    if not batch_by_year:
        return {"eligible": False, "year": year, "available_years": [], "required_years": 10,
                "message": "No hay datos cargados de años anteriores al seleccionado."}

    history = []
    province_filter = province_key(province) if province else None
    for data_year, batch in sorted(batch_by_year.items()):
        query = db.query(Observation).filter(
            Observation.import_id == batch.id,
            Observation.sex == "total",
            Observation.indicator.in_(["promovidos", "nopromo"]),
        )
        promoted = not_promoted = 0.0
        for row in query.all():
            if province_filter and province_key(row.provincia) != province_filter:
                continue
            if row.indicator == "promovidos":
                promoted += row.value
            else:
                not_promoted += row.value
        denominator = promoted + not_promoted
        if denominator > 0:
            history.append({"year": data_year, "rate": not_promoted / denominator * 100})

    # Holt treats adjacent observations as equally spaced. Use the most recent
    # consecutive run so missing years are never silently compressed.
    contiguous = []
    for item in reversed(history):
        if contiguous and item["year"] != contiguous[-1]["year"] - 1:
            break
        contiguous.append(item)
    contiguous.reverse()
    if len(contiguous) < 10:
        return {
            "eligible": False, "year": year, "available_years": [item["year"] for item in contiguous],
            "required_years": 10,
            "message": f"Se necesitan 10 años consecutivos anteriores con datos válidos; hay {len(contiguous)}.",
        }
    if contiguous[-1]["year"] >= year:
        raise HTTPException(422, "El año a predecir debe ser posterior al último año usado.")

    by_year = {item["year"]: item["rate"] for item in contiguous}
    imputed_year = None
    # The notebook's final fit interpolates 2021 between 2020 and 2022;
    # for forecasts made before 2022, avoid using a future observation.
    if 2021 in by_year:
        if 2020 in by_year and 2022 in by_year:
            by_year[2021] = (by_year[2020] + by_year[2022]) / 2
            imputed_year = 2021
        elif 2019 in by_year and 2020 in by_year:
            by_year[2021] = (by_year[2019] + by_year[2020]) / 2
            imputed_year = 2021

    try:
        model = Holt(
            [by_year[item["year"]] for item in contiguous],
            damped_trend=True,
            initialization_method="estimated",
        ).fit(smoothing_level=0.6, smoothing_trend=0.2, damping_trend=0.8)
        steps = year - contiguous[-1]["year"]
        forecast_values = model.forecast(steps)
    except (ValueError, FloatingPointError) as exc:
        raise HTTPException(422, f"No se pudo ajustar Holt con estos datos: {exc}") from exc

    predicted = float(forecast_values[-1])
    forecast_series = [
        {"year": contiguous[-1]["year"] + offset, "rate": float(value)}
        for offset, value in enumerate(forecast_values, start=1)
    ]
    return {
        "eligible": True,
        "year": year,
        "province": province or "Nación",
        "area": "todos",
        "sex": "total",
        "history": [{"year": item["year"], "rate": by_year[item["year"]], "imputed": item["year"] == imputed_year} for item in contiguous],
        "forecast": predicted,
        "forecast_series": forecast_series,
        "forecast_steps": steps,
        "required_years": 10,
        "model": "Holt con tendencia amortiguada e imputación de 2021",
        "parameters": {"smoothing_level": 0.6, "smoothing_trend": 0.2, "damping_trend": 0.8},
        "imputed_year": imputed_year,
    }


@app.get("/api/statistics")
def statistics(
    year: int,
    indicator: str = "promovidos",
    db: Session = Depends(get_db),
):
    """Resumen y agregaciones de la última importación del año seleccionado."""
    batch = (
        db.query(ImportBatch)
        .filter(ImportBatch.year == year)
        .order_by(ImportBatch.id.desc())
        .first()
    )
    if batch is None:
        raise HTTPException(404, "No hay datos cargados para ese año.")

    base = db.query(Observation).filter(Observation.import_id == batch.id)
    total_observations = base.count()
    provinces = base.with_entities(func.count(func.distinct(Observation.provincia))).scalar() or 0
    departments = base.with_entities(
        func.count(func.distinct(Observation.departamento + "|" + Observation.provincia))
    ).scalar() or 0
    totals = {
        name: value or 0
        for name, value in (
            base.filter(Observation.sex == "total")
            .with_entities(Observation.indicator, func.sum(Observation.value))
            .group_by(Observation.indicator)
            .all()
        )
    }


@app.get("/api/statistics/province-map")
def province_map_statistics(year: int, db: Session = Depends(get_db)):
    """Conteos y tasas exploratorias agregados por provincia para el mapa."""
    batch = (
        db.query(ImportBatch)
        .filter(ImportBatch.year == year)
        .order_by(ImportBatch.id.desc())
        .first()
    )
    if batch is None:
        raise HTTPException(404, "No hay datos cargados para ese año.")

    rows = (
        db.query(Observation.provincia, Observation.indicator, func.sum(Observation.value))
        .filter(Observation.import_id == batch.id, Observation.sex == "total")
        .group_by(Observation.provincia, Observation.indicator)
        .all()
    )
    values: dict[str, dict[str, float]] = {}
    for province, indicator, value in rows:
        values.setdefault(province, {})[indicator] = float(value or 0)

    # The age composition comes from Censo 2022. Apply each department's share of
    # ages 4-17 to its annual population estimate, then aggregate by province.
    age_shares = {
        (province_key(province), department_key(department)): percentage / 100
        for province, department, sex, percentage in db.query(
            SchoolAgePercentage.provincia,
            SchoolAgePercentage.departamento,
            SchoolAgePercentage.sexo,
            SchoolAgePercentage.porcentaje_edad_escolar,
        ).filter(SchoolAgePercentage.sexo == "Ambos sexos").all()
    }
    population_rows = (
        db.query(
            PopulationEstimate.provincia,
            PopulationEstimate.departamento,
            PopulationEstimate.poblacion,
        )
        .filter(PopulationEstimate.year == year, PopulationEstimate.sexo == "Ambos sexos")
        .all()
    )
    school_age_population_by_province: dict[str, float] = {}
    for province, department, population in population_rows:
        share = age_shares.get((province_key(province), department_key(department)))
        if share is None:
            continue
        key = province_key(province)
        school_age_population_by_province[key] = school_age_population_by_province.get(key, 0) + int(population or 0) * share

    result = []
    for province, totals in values.items():
        enrolled = totals.get("inicial")
        school_age_population = school_age_population_by_province.get(province_key(province))
        promoted = totals.get("promovidos")
        not_promoted = totals.get("nopromo")
        promotion_base = (promoted or 0) + (not_promoted or 0)
        exits_without_transfer = totals.get("ssp")
        result.append(
            {
                "province": province,
                "enrolled": enrolled,
                "school_age_population": school_age_population,
                "enrollment_rate": enrolled / school_age_population * 100 if enrolled is not None and school_age_population else None,
                "promoted": promoted,
                "not_promoted": not_promoted,
                "exits_without_transfer": exits_without_transfer,
                "promotion_rate": promoted / promotion_base * 100 if promoted is not None and not_promoted is not None and promotion_base > 0 else None,
                "not_promotion_rate": not_promoted / promotion_base * 100 if promoted is not None and not_promoted is not None and promotion_base > 0 else None,
                "abandonment_rate": exits_without_transfer / enrolled * 100 if exits_without_transfer is not None and enrolled is not None and enrolled > 0 else None,
            }
        )
    return {"year": year, "import_id": batch.id, "provinces": result}


@app.get("/api/statistics/department-map")
def department_map_statistics(year: int, province: str, db: Session = Depends(get_db)):
    """Conteos y tasas exploratorias agregados por departamento/partido/comuna."""
    batch = (
        db.query(ImportBatch)
        .filter(ImportBatch.year == year)
        .order_by(ImportBatch.id.desc())
        .first()
    )
    if batch is None:
        raise HTTPException(404, "No hay datos cargados para ese año.")

    selected_key = province_key(province)
    rows = (
        db.query(
            Observation.provincia,
            Observation.departamento,
            Observation.indicator,
            func.sum(Observation.value),
        )
        .filter(Observation.import_id == batch.id, Observation.sex == "total")
        .group_by(Observation.provincia, Observation.departamento, Observation.indicator)
        .all()
    )
    values: dict[str, dict[str, float]] = {}
    department_names: dict[str, str] = {}
    for observed_province, department, indicator, value in rows:
        if province_key(observed_province) != selected_key:
            continue
        key = department_key(department)
        if selected_key == "tierra del fuego" and key in {"antartida argentina", "islas del atlantico sur"}:
            continue
        department_names.setdefault(key, department)
        bucket = values.setdefault(key, {})
        bucket[indicator] = bucket.get(indicator, 0) + float(value or 0)

    age_shares = {
        department_key(department): percentage / 100
        for row_province, department, percentage in db.query(
            SchoolAgePercentage.provincia,
            SchoolAgePercentage.departamento,
            SchoolAgePercentage.porcentaje_edad_escolar,
        ).filter(SchoolAgePercentage.sexo == "Ambos sexos").all()
        if province_key(row_province) == selected_key
    }
    population_rows = (
        db.query(
            PopulationEstimate.provincia,
            PopulationEstimate.departamento,
            PopulationEstimate.poblacion,
        )
        .filter(PopulationEstimate.year == year, PopulationEstimate.sexo == "Ambos sexos")
        .all()
    )
    school_age_population: dict[str, float] = {}
    for row_province, department, population in population_rows:
        if province_key(row_province) != selected_key:
            continue
        key = department_key(department)
        share = age_shares.get(key)
        if share is not None:
            school_age_population[key] = school_age_population.get(key, 0) + int(population or 0) * share

    departments = []
    for key, totals in values.items():
        enrolled = totals.get("inicial")
        denominator = school_age_population.get(key)
        promoted = totals.get("promovidos")
        not_promoted = totals.get("nopromo")
        promotion_base = (promoted or 0) + (not_promoted or 0)
        exits_without_transfer = totals.get("ssp")
        departments.append(
            {
                "name": department_names[key],
                "enrolled": enrolled,
                "school_age_population": denominator,
                "enrollment_rate": enrolled / denominator * 100 if enrolled is not None and denominator else None,
                "promoted": promoted,
                "not_promoted": not_promoted,
                "exits_without_transfer": exits_without_transfer,
                "promotion_rate": promoted / promotion_base * 100 if promoted is not None and not_promoted is not None and promotion_base > 0 else None,
                "not_promotion_rate": not_promoted / promotion_base * 100 if promoted is not None and not_promoted is not None and promotion_base > 0 else None,
                "abandonment_rate": exits_without_transfer / enrolled * 100 if exits_without_transfer is not None and enrolled is not None and enrolled > 0 else None,
            }
        )
    return {"year": year, "import_id": batch.id, "province": province, "departments": departments}


@app.get("/api/statistics/study-year-distribution")
def study_year_distribution(
    year: int,
    indicator: str = "enrollment_rate",
    province: str | None = None,
    db: Session = Depends(get_db),
):
    """Distribución por año de estudio, excluyendo categorías especiales 13-14 y 20."""
    batch = (
        db.query(ImportBatch)
        .filter(ImportBatch.year == year)
        .order_by(ImportBatch.id.desc())
        .first()
    )
    if batch is None:
        raise HTTPException(404, "No hay datos cargados para ese año.")
    if indicator not in {"enrollment_rate", "promotion_rate", "not_promotion_rate", "abandonment_rate"}:
        raise HTTPException(400, "Indicador no válido.")

    source_indicators = {
        "enrollment_rate": ["inicial"],
        "promotion_rate": ["promovidos", "nopromo"],
        "not_promotion_rate": ["promovidos", "nopromo"],
        "abandonment_rate": ["ssp", "inicial"],
    }[indicator]
    rows = (
        db.query(
            Observation.provincia,
            Observation.study_year,
            Observation.indicator,
            func.sum(Observation.value),
        )
        .filter(
            Observation.import_id == batch.id,
            Observation.sex == "total",
            Observation.study_year.in_([str(number) for number in range(1, 13)]),
            Observation.indicator.in_(source_indicators),
        )
        .group_by(Observation.provincia, Observation.study_year, Observation.indicator)
        .all()
    )
    totals: dict[str, dict[str, float]] = {}
    selected_province = province_key(province) if province else None
    for observed_province, study_year, source_indicator, value in rows:
        if selected_province and province_key(observed_province) != selected_province:
            continue
        bucket = totals.setdefault(study_year, {})
        bucket[source_indicator] = bucket.get(source_indicator, 0) + float(value or 0)

    enrollment_total = sum(values.get("inicial", 0) for values in totals.values())
    points = []
    for study_year in range(1, 13):
        values = totals.get(str(study_year), {})
        if indicator == "enrollment_rate":
            amount = values.get("inicial")
            rate = amount / enrollment_total * 100 if amount is not None and enrollment_total > 0 else None
        elif indicator in {"promotion_rate", "not_promotion_rate"}:
            promoted = values.get("promovidos")
            not_promoted = values.get("nopromo")
            denominator = (promoted or 0) + (not_promoted or 0)
            numerator = promoted if indicator == "promotion_rate" else not_promoted
            rate = numerator / denominator * 100 if numerator is not None and denominator > 0 else None
            amount = numerator
        else:
            amount = values.get("ssp")
            denominator = values.get("inicial")
            rate = amount / denominator * 100 if amount is not None and denominator is not None and denominator > 0 else None

        points.append(
            {
                "study_year": study_year,
                "label": f"{study_year}° grado" if study_year <= 6 else f"{study_year - 6}° año",
                "level": "Primaria" if study_year <= 6 else "Secundaria",
                "value": rate,
                "amount": amount,
            }
        )
    return {
        "year": year,
        "province": province,
        "indicator": indicator,
        "distribution_type": "enrollment_share" if indicator == "enrollment_rate" else "rate",
        "study_years": points,
    }


@app.get("/api/statistics/equality")
def equality_statistics(
    year: int,
    province: str | None = None,
    department: str | None = None,
    db: Session = Depends(get_db),
):
    """Tasas de promoción por sexo y ámbito para el territorio seleccionado."""
    batch = (
        db.query(ImportBatch)
        .filter(ImportBatch.year == year)
        .order_by(ImportBatch.id.desc())
        .first()
    )
    if batch is None:
        raise HTTPException(404, "No hay datos cargados para ese año.")

    base = db.query(Observation).filter(Observation.import_id == batch.id)
    provinces = [row[0] for row in base.with_entities(Observation.provincia).distinct().order_by(Observation.provincia).all()]
    departments = []
    if province:
        departments = [row[0] for row in base.filter(Observation.provincia == province)
            .with_entities(Observation.departamento).distinct().order_by(Observation.departamento).all()]

    scoped = base
    if province:
        scoped = scoped.filter(Observation.provincia == province)
    if department:
        scoped = scoped.filter(Observation.departamento == department)
    rows = scoped.filter(Observation.indicator.in_(["promovidos", "nopromo"])).with_entities(
        Observation.ambito, Observation.sex, Observation.indicator, func.sum(Observation.value)
    ).group_by(Observation.ambito, Observation.sex, Observation.indicator).all()

    sex_totals: dict[str, dict[str, float]] = {}
    area_totals: dict[str, dict[str, float]] = {}
    for area, sex, indicator, value in rows:
        amount = float(value or 0)
        sex_bucket = sex_totals.setdefault(sex, {})
        sex_bucket[indicator] = sex_bucket.get(indicator, 0) + amount
        normalized_area = (area or "").strip().lower()
        if sex == "total":
            category = "Urbano" if "urban" in normalized_area else "Rural" if "rural" in normalized_area else None
            if category:
                area_bucket = area_totals.setdefault(category, {})
                area_bucket[indicator] = area_bucket.get(indicator, 0) + amount

    def rate(values: dict[str, float] | None):
        if not values or "promovidos" not in values or "nopromo" not in values:
            return None
        total = values["promovidos"] + values["nopromo"]
        return values["promovidos"] / total * 100 if total > 0 else None

    totals, women = sex_totals.get("total", {}), sex_totals.get("mujeres", {})
    men = {
        indicator: value - women.get(indicator, 0)
        for indicator, value in totals.items()
    } if "promovidos" in women and "nopromo" in women else None
    return {
        "year": year,
        "province": province,
        "department": department,
        "provinces": provinces,
        "departments": departments,
        "by_sex": [
            {"label": "Hombres", "rate": rate(men)},
            {"label": "Mujeres", "rate": rate(women)},
        ],
        "by_area": [
            {"label": "Urbano", "rate": rate(area_totals.get("Urbano"))},
            {"label": "Rural", "rate": rate(area_totals.get("Rural"))},
        ],
    }

    province_rows = (
        base.filter(Observation.indicator == indicator, Observation.sex == "total")
        .with_entities(Observation.provincia, func.sum(Observation.value).label("value"))
        .group_by(Observation.provincia)
        .order_by(func.sum(Observation.value).desc())
        .all()
    )
    study_rows = (
        base.filter(Observation.indicator == indicator, Observation.sex == "total")
        .with_entities(Observation.study_year, func.sum(Observation.value).label("value"))
        .group_by(Observation.study_year)
        .all()
    )

    graduates = totals.get("primaria_egresados", 0) + totals.get("secundaria_egresados", 0)
    return {
        "year": batch.year,
        "import_id": batch.id,
        "file_name": batch.file_name,
        "summary": {
            "observations": total_observations,
            "provinces": provinces,
            "departments": departments,
            "promoted": totals.get("promovidos", 0),
            "not_promoted": totals.get("nopromo", 0),
            "graduates": graduates,
        },
        "available_indicators": sorted(totals.keys()),
        "by_province": [{"label": name, "value": float(value or 0)} for name, value in province_rows],
        "by_study_year": [{"label": name, "value": float(value or 0)} for name, value in study_rows],
    }


@app.post("/api/imports", response_model=UploadResponse, status_code=201)
async def upload_dataset(
    year: int = Form(..., ge=1900, le=2100),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Formato no soportado. Subí CSV, TXT, XLSX o XLS.")

    temp_path = None
    try:
        with NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_file.write(await file.read())
            temp_path = Path(temp_file.name)

        observations = procesar_archivo(temp_path, year=year)
        if not observations:
            raise HTTPException(422, "El archivo no contiene observaciones válidas.")

        batch = ImportBatch(file_name=Path(file.filename or "dataset").name, year=year)
        db.add(batch)
        db.flush()
        db.add_all(
            Observation(import_id=batch.id, **item.model_dump())
            for item in observations
        )
        db.commit()
        return UploadResponse(
            import_id=batch.id,
            file_name=batch.file_name,
            year=year,
            rows_processed=len(observations),
            message="Archivo procesado y guardado correctamente.",
        )
    except HTTPException:
        db.rollback()
        raise
    except (ValueError, OSError) as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(500, "No se pudo guardar la importación.") from exc
    finally:
        await file.close()
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
