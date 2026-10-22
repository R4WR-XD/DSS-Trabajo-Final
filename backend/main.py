"""API de carga para el DSS de trayectorias educativas."""

from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
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
