FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY pdfcensal/poblacion_provincia_departamento_sexo_anio.csv ./pdfcensal/poblacion_provincia_departamento_sexo_anio.csv
COPY pdfcensal/porcentaje_poblacion_edad_escolar.csv ./pdfcensal/porcentaje_poblacion_edad_escolar.csv
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
