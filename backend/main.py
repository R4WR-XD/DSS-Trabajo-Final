"""API de carga para el DSS de trayectorias educativas."""

from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import models
from .database import Base, engine, get_db
from .models import ImportBatch, Observation
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
