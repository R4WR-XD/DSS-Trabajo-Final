# DSS-Trabajo-Final

Trabajo práctico final para la materia Sistemas de Soporte a la Toma de Decisiones: aplicación de análisis y soporte para datos educativos.

## Estructura

- `backend/`: API FastAPI, procesador existente y persistencia con SQLAlchemy/PostgreSQL.
- `frontend/`: interfaz React + TypeScript con Vite para importar datasets.
- `docker-compose.yml`: PostgreSQL y API para desarrollo local.

Cada carga crea un registro en `import_batches` y guarda sus observaciones normalizadas en `observations`, asociadas a esa importación. Los archivos admitidos son CSV, TXT, XLSX y XLS. El CSV debe incluir las columnas territoriales `provincia`, `departamento`, `sector` y `ambito` que espera el procesador actual.

## Ejecutar backend y base

Con Docker Compose:

```bash
docker compose up --build
```

La API queda en <http://localhost:8000>, la documentación interactiva en <http://localhost:8000/docs> y PostgreSQL en el puerto `5432`. Para desarrollo local sin Docker, crear un entorno virtual, instalar `backend/requirements.txt`, definir `DATABASE_URL` y ejecutar desde la raíz:

```bash
uvicorn backend.main:app --reload
```

Por defecto, la conexión local es `postgresql+psycopg://dss:dss@localhost:5432/dss_educacion`.

## Ejecutar frontend

```bash
cd frontend
npm install
npm run dev
```

Abrir <http://localhost:5173>. Vite reenvía las llamadas `/api` a la API local en el puerto `8000`.

La pantalla envía `year` y `file` como `multipart/form-data` a `POST /api/imports`. La API responde con el identificador de importación y la cantidad de observaciones guardadas.

## Estadísticas

La navegación lateral permite abrir **Estadísticas** y elegir entre los años importados. El panel consulta `GET /api/statistics/years` y `GET /api/statistics?year=2025&indicator=promovidos`, y muestra cobertura, observaciones y gráficos por provincia y año de estudio. Si se vuelve a importar un año, el panel usa la importación más reciente de ese año para evitar sumar cargas repetidas.
