"""Tablas para registrar importaciones y observaciones procesadas."""

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    observations: Mapped[list["Observation"]] = relationship(
        back_populates="import_batch", cascade="all, delete-orphan"
    )


class Observation(Base):
    __tablename__ = "observations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    import_id: Mapped[int] = mapped_column(
        ForeignKey("import_batches.id", ondelete="CASCADE"), index=True, nullable=False
    )
    year: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    provincia: Mapped[str] = mapped_column(String(160), index=True, nullable=False)
    departamento: Mapped[str] = mapped_column(String(160), index=True, nullable=False)
    sector: Mapped[str | None] = mapped_column(String(120))
    ambito: Mapped[str | None] = mapped_column(String(120))
    study_year: Mapped[str] = mapped_column(String(32), nullable=False)
    study_year_group: Mapped[str] = mapped_column(String(64), nullable=False)
    indicator: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    sex: Mapped[str] = mapped_column(String(16), nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    source_column: Mapped[str] = mapped_column(String(160), nullable=False)

    import_batch: Mapped[ImportBatch] = relationship(back_populates="observations")
