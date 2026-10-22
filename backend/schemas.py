
"""Schemas de API; el modelo de observación está junto al procesador."""

from pydantic import BaseModel


class UploadResponse(BaseModel):
    import_id: int
    file_name: str
    year: int
    rows_processed: int
    message: str
