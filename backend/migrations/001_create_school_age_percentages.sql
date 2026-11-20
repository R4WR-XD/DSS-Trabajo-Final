-- Guarda el porcentaje censal de población de 4 a 17 años por territorio y sexo.
-- Ejecutar una vez contra la base DSS (es idempotente si la tabla ya existe).
CREATE TABLE IF NOT EXISTS school_age_percentages (
    provincia VARCHAR(160) NOT NULL,
    departamento VARCHAR(160) NOT NULL,
    sexo VARCHAR(20) NOT NULL,
    porcentaje_edad_escolar DOUBLE PRECISION NOT NULL,
    CONSTRAINT pk_school_age_percentages
        PRIMARY KEY (provincia, departamento, sexo),
    CONSTRAINT ck_school_age_percentages_range
        CHECK (porcentaje_edad_escolar >= 0 AND porcentaje_edad_escolar <= 100)
);
