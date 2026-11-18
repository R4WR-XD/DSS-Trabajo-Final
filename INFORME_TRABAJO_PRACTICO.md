# Informe del trabajo práctico

## Sistema de soporte a la toma de decisiones sobre trayectorias educativas

**Materia:** Sistemas de Soporte a la Toma de Decisiones  
**Integrantes:** [Completar]  
**Docente:** [Completar]  
**Fecha de entrega:** [Completar]

---

## 1. Resumen

El trabajo consiste en una aplicación web para importar, ordenar y explorar información anual sobre trayectorias educativas en Argentina. El sistema organiza los registros por provincia, departamento, sector de gestión, ámbito, año de estudio, indicador y sexo. Luego permite consultar resúmenes y gráficos por provincia y año de estudio.

La aplicación funciona como una ayuda para explorar los datos y formular preguntas. Los gráficos resumen la información cargada; no explican por sí solos las causas de los resultados ni reemplazan las definiciones oficiales de los indicadores.

## 2. Objetivo del sistema

El objetivo es facilitar la consulta de datos educativos que suelen venir en planillas extensas, con muchas columnas. Para eso, la plataforma permite:

- cargar un archivo anual en formato CSV, TXT, XLSX o XLS;
- validar y normalizar sus dimensiones territoriales y variables reconocidas;
- guardar cada carga junto con el año y nombre del archivo de origen;
- consultar qué años están disponibles y explorar cantidades por indicador, provincia y año de estudio.

El panel utiliza la importación más reciente cuando hay más de una carga para el mismo año, evitando sumar accidentalmente archivos repetidos. La carga del archivo es manual: el sistema no descarga automáticamente bases del organismo de origen.

## 3. Dataset educativo

### 3.1 Origen y alcance

El sistema está preparado para trabajar con bases usuarias por escuela del **Relevamiento Anual (RA)** de educación, producido por la Secretaría de Educación de la Nación. El RA es un relevamiento anual del sistema educativo. El proyecto no incluye una copia de la base original; cada usuario debe proporcionar el archivo correspondiente.

En el estado actual del código, el archivo debe incluir las columnas territoriales `provincia`, `departamento`, `sector` y `ambito`. El procesador las usa para ubicar y describir cada registro. Las columnas con otras variables se reconocen cuando su encabezado coincide con los patrones documentados más abajo.

Fuentes de consulta del origen y de las definiciones:

- [Estadísticas educativas nacionales](https://www.argentina.gob.ar/capital-humano/estadisticas-educativas)
- [Diccionario de datos de las bases usuarias](https://www.argentina.gob.ar/sites/default/files/diccionario_de_datos.pdf)

### 3.2 ¿Qué significa una observación?

Una fila del archivo original puede contener muchos valores: por ejemplo, cantidades de promovidos para varios años de estudio y, además, cantidades de mujeres. El procesador transforma esos valores a un formato largo: cada combinación de territorio, variable, año de estudio y sexo queda como una observación independiente.

Así, en vez de tener una sola fila muy ancha con muchas columnas, la base guarda registros comparables y fáciles de filtrar. Los ceros se conservan; las celdas vacías o que no se pueden leer como números se omiten.

### 3.3 Cómo se procesan las columnas

| Columna o grupo | Explicación amigable | Tratamiento en el sistema |
|---|---|---|
| `provincia` | Jurisdicción donde se registra el dato. | Obligatoria; se recortan espacios al inicio y al final. |
| `departamento` | Departamento, partido o comuna según la división territorial de la jurisdicción. | Obligatoria; se recortan espacios. Si provincia o departamento faltan en una fila, esa fila se descarta. |
| `sector` | Tipo de gestión del establecimiento, por ejemplo estatal o privado, según el archivo de origen. | Se guarda como dimensión opcional; el programa no traduce ni recodifica sus categorías. |
| `ambito` | Ámbito indicado por la base, por ejemplo urbano o rural. | Se guarda como dimensión opcional, sin recodificación automática. |
| Columnas de indicadores | Encabezados como `promovidos_1`, `nopromo_7`, `regulares_3` o `primaria_egresados`. | El nombre se separa en indicador y año de estudio, si el formato es reconocido. |
| Prefijo `m_` | Marca el dato correspondiente a mujeres en nombres como `m_promovidos_1`. | Se guarda con sexo `mujeres`. Si no aparece ese prefijo, se etiqueta `total`; eso representa la columna total del archivo, no una suma que calcule el sistema. |
| Valor de la celda | Cantidad asociada a esa categoría y ubicación. | Se convierte a número. Se admiten decimales con coma si no hay punto decimal. Texto no numérico y celdas vacías se omiten. |
| Sufijo del año de estudio | Número después del indicador, por ejemplo `_1`, `_6` o `_7`. | Se conserva como año cursado. Los años 1 a 6 se agrupan como `años_1_a_6`; 7 a 12 como `años_7_a_12`. Es una agrupación técnica para filtrar, no una clasificación oficial del nivel educativo. |
| Sufijos especiales | `_1314`, `_20` o indicadores de egreso sin número de año. | `_1314` se interpreta como `13-14`; `_20` como `20`; egresos de primaria/secundaria como `no_aplica`. Se agrupan bajo `categoría_especial`. |
| `year` | Año del dataset que la persona informa al subir el archivo. | Se agrega durante la carga; no se deduce del nombre del archivo ni de las celdas. |
| `source_column` | Encabezado original del que salió el valor. | Se conserva para poder rastrear la observación hasta su columna de origen. |

Se reconocen, entre otros, los indicadores `promovidos`, `nopromo`, `regulares`, `entrados`, `inicial`, `scp`, `ssp`, `ultimo`, `otros`, `primaria_egresados` y `secundaria_egresados`, siempre que los encabezados sigan los patrones esperados. Las columnas desconocidas se ignoran. Por eso conviene revisar el diccionario oficial y los encabezados concretos de cada archivo antes de interpretar resultados.

### 3.4 Qué muestran las estadísticas

La API suma los valores de la importación elegida y expone cantidades por indicador, provincia y año de estudio. En los gráficos se usan registros etiquetados como `total`. El panel no calcula automáticamente tasas oficiales. El script auxiliar de transformación contiene algunas razones exploratorias, pero el backend y el panel descritos aquí muestran principalmente sumas. Una suma de matrículas o trayectorias no debe llamarse “tasa” sin definir antes su numerador, denominador y población de referencia.

## 4. Datos geográficos

### 4.1 Archivos incluidos

La interfaz incluye dos archivos GeoJSON locales:

- `frontend/src/data/provincias.geojson`: 24 entidades jurisdiccionales;
- `frontend/src/data/departamentos.geojson`: 529 entidades de segundo nivel, incluyendo departamentos, partidos y comunas.

GeoJSON es un formato que describe figuras geográficas y sus atributos. En estos archivos las figuras son polígonos. Entre los atributos aparecen identificadores, nombres, provincia asociada y centroides (un punto representativo para ubicar la entidad). Los registros inspeccionados identifican `IGN` como fuente.

### 4.2 Fuente y uso

Los archivos corresponden a la cartografía de unidades territoriales difundida por **Georef Argentina**, el servicio público de normalización de datos geográficos. Georef publica recursos descargables en GeoJSON para provincias y departamentos. La información de límites se basa en antecedentes cartográficos del Instituto Geográfico Nacional (IGN), legislación y otras fuentes oficiales.

- [Descarga de la base completa de Georef Argentina](https://www.argentina.gob.ar/georef/descarga-de-la-base-completa)
- [Conjunto de datos de unidades territoriales en Datos Argentina](https://www.datos.gob.ar/dataset/ign-unidades-territoriales)

Los GeoJSON son insumos de referencia cartográfica. No contienen por sí solos los indicadores educativos ni la población estimada. Para cruzarlos con las observaciones se deben emparejar códigos/nombres territoriales con cuidado: puede haber diferencias de escritura, cambios de límites o nombres, y la geometría no prueba que dos registros sean equivalentes.

## 5. Estimaciones de población 2010–2025

El INDEC publicó una serie de **estimaciones de población por sexo, departamento, partido y comuna para 2010–2025**, con valores al 1 de julio de cada año. La publicación se construyó a partir de las proyecciones provinciales vigentes y del crecimiento intercensal 2001–2010 (fecundidad, mortalidad y migración). Para áreas menores se emplearon procedimientos de estimación, por lo que son estimaciones y no conteos censales anuales.

- [INDEC: estimaciones por departamento, años 2010–2025](https://sitioanterior.indec.gob.ar/nivel4_default.asp?id_tema_1=2&id_tema_2=24&id_tema_3=119)
- [Informe técnico de la serie 2010–2025 (PDF)](https://www.indec.gob.ar/ftp/cuadros/poblacion/proyeccion_departamentos_10_25.pdf)

**Advertencia para interpretar esta serie:** el INDEC indica que para varias jurisdicciones las estimaciones departamentales deben considerarse con reservas debido a problemas detectados en registros replicados en la base provincial del Censo 2010. Además, en 2025 el INDEC publicó una serie nueva basada en el Censo 2022, para departamentos y provincias, para el período 2022–2035. Por lo tanto, el valor 2025 de la serie antigua 2010–2025 y el de la serie nueva 2022–2035 pueden diferir porque parten de bases y metodologías diferentes. Para un análisis actualizado conviene usar la serie nueva en los años que cubre, mantener identificada la edición de la fuente y no unir ambas series como si fueran una única medición homogénea.

- [INDEC: estimaciones departamentales 2022–2035](https://www.indec.gob.ar/ftp/cuadros/publicaciones/estimaciones_departamentos_2022_2035.pdf)
- [Portal de proyecciones del Censo 2022](https://censo.gob.ar/index.php/proyecciones/)

En el código y archivos revisados de este proyecto no se encontró una tabla de población ni un proceso que la importe o la vincule con los GeoJSON. Por eso, la población 2010–2025 se documenta aquí como fuente externa potencial para una ampliación, no como una función actualmente disponible en el sistema. Para incorporar este indicador sería necesario descargar los cuadros del INDEC, estructurarlos con un código territorial estable y validar las correspondencias con los departamentos de Georef.

## 6. Flujo general de datos

1. La persona selecciona el año de referencia y carga una planilla.
2. La API lee CSV/TXT o Excel e intenta detectar separador y codificación para los archivos de texto.
3. El procesador normaliza encabezados y espacios, exige las cuatro dimensiones territoriales y reconoce nombres de indicadores.
4. Cada valor numérico se transforma en una observación con territorio, año, indicador, sexo y año de estudio.
5. La API guarda la importación y las observaciones asociadas en PostgreSQL.
6. El panel consulta la última importación del año seleccionado y presenta resúmenes y gráficos.

## 7. Alcances y consideraciones

- Los resultados dependen del archivo cargado y de que respete los nombres de columnas esperados.
- El procesador no homogeneiza categorías de `sector` y `ambito`, ni corrige automáticamente nombres territoriales.
- Las columnas no reconocidas y las celdas vacías/no numéricas no se incluyen en las observaciones.
- “Total” es la etiqueta que el programa asigna a una columna sin el prefijo femenino; hay que respetar el significado que tenga esa columna en el archivo oficial.
- Los valores se agregan como sumas para los gráficos. No equivalen automáticamente a tasas ni permiten inferir causalidad.
- La cartografía y la población son fuentes distintas de la base educativa y requieren una integración explícita antes de producir mapas o indicadores por habitante.
- La serie poblacional 2010–2025 es una estimación histórica del INDEC; su metodología no debe confundirse con un recuento censal observado cada año.

## 8. Conclusión

La aplicación organiza datos anuales del Relevamiento Anual en un formato que facilita consultas y comparaciones territoriales y por año de estudio. Su aporte principal es hacer más accesibles archivos extensos y conservar la procedencia de cada observación. Los GeoJSON aportan límites y atributos territoriales de referencia. Las estimaciones demográficas 2010–2025 del INDEC pueden servir para contextualizar el análisis, pero todavía no están integradas en la aplicación y deben incorporarse respetando sus advertencias metodológicas y su correspondencia geográfica.

## Referencias

- Secretaría de Educación de la Nación. [Estadísticas educativas nacionales](https://www.argentina.gob.ar/capital-humano/estadisticas-educativas).
- Secretaría de Educación de la Nación. [Diccionario de datos de las bases usuarias](https://www.argentina.gob.ar/sites/default/files/diccionario_de_datos.pdf).
- Georef Argentina. [Descarga de la base completa](https://www.argentina.gob.ar/georef/descarga-de-la-base-completa).
- Datos Argentina. [Unidades territoriales](https://www.datos.gob.ar/dataset/ign-unidades-territoriales).
- INDEC. [Estimaciones de población por sexo, departamento y año calendario, 2010–2025](https://www.indec.gob.ar/ftp/cuadros/poblacion/proyeccion_departamentos_10_25.pdf).
- INDEC. [Estimaciones de población por sexo, departamento y año calendario, 2022–2035](https://www.indec.gob.ar/ftp/cuadros/publicaciones/estimaciones_departamentos_2022_2035.pdf).
