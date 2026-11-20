import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'

type ImportResult = {
  import_id: number
  file_name: string
  year: number
  rows_processed: number
  message: string
}
type AvailableYear = { year: number; import_id: number; file_name: string }
type MapMetric = 'enrollment_rate' | 'promotion_rate' | 'not_promotion_rate' | 'abandonment_rate'
type ProvinceMetric = {
  province: string
  enrolled: number | null
  school_age_population: number | null
  enrollment_rate: number | null
  promoted: number | null
  not_promoted: number | null
  exits_without_transfer: number | null
  promotion_rate: number | null
  not_promotion_rate: number | null
  abandonment_rate: number | null
}
type GeoPosition = [number, number, ...number[]]
type ProvinceFeature = {
  type: 'Feature'
  properties: { nombre: string; [key: string]: unknown }
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }
}
type ProvinceFeatureCollection = { type: 'FeatureCollection'; features: ProvinceFeature[] }
type EqualityPoint = { label: string; rate: number | null }
type EqualityStatistics = {
  provinces: string[]
  departments: string[]
  by_sex: EqualityPoint[]
  by_area: EqualityPoint[]
}

type Section = 'summary' | 'equality' | 'predictive' | 'reports' | 'upload' | 'about'
const SECTION_PATHS: Record<Section, string> = {
  summary: '/trayectorias', equality: '/igualdad', predictive: '/predictivo', reports: '/reportes', upload: '/subir-archivo', about: '/acerca-de',
}
function sectionFromPath(path: string): Section {
  return (Object.entries(SECTION_PATHS).find(([, route]) => route === path)?.[0] as Section | undefined) ?? 'summary'
}

function NavIcon({ kind }: { kind: 'document' | 'scale' | 'sparkle' | 'chart' }) {
  return <svg className="nav-icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'document' && <><path d="M6 3.75h8l4 4V20a.75.75 0 0 1-.75.75h-11.5A.75.75 0 0 1 5 20V4.5a.75.75 0 0 1 .75-.75Z"/><path d="M14 4v4h4M8.5 12h7M8.5 15.5h7"/></>}
    {kind === 'scale' && <><path d="M12 4v15M8 20h8M5 7h14M12 4l-2-2M12 4l2-2"/><path d="m6 7-3 6h6L6 7Zm12 0-3 6h6l-3-6Z"/><path d="M3 13c0 2 1.2 3 3 3s3-1 3-3m6 0c0 2 1.2 3 3 3s3-1 3-3"/></>}
    {kind === 'sparkle' && <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15ZM5 3l.7 1.8L7.5 5.5l-1.8.7L5 8l-.7-1.8-1.8-.7 1.8-.7L5 3Z"/></>}
    {kind === 'chart' && <><path d="M4 20V4M4 20h17"/><path d="M7 17v-5h3v5M12 17V8h3v9M17 17V5h3v12"/></>}
  </svg>
}

const formatNumber = (value: number) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(value)
const formatPercent = (value: number) => `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(value)}%`
const MAP_METRICS: { id: MapMetric; label: string; description: string }[] = [
  { id: 'enrollment_rate', label: 'Matrícula relativa', description: 'Matrícula inicial sobre población estimada de 4 a 17 años' },
  { id: 'promotion_rate', label: 'Promoción', description: 'Promovidos sobre promovidos + no promovidos' },
  { id: 'not_promotion_rate', label: 'No promoción', description: 'No promovidos sobre promovidos + no promovidos' },
  { id: 'abandonment_rate', label: 'Abandono', description: 'Salidos sin pase sobre matrícula inicial' },
]

function provinceKey(name: string) {
  const key = name.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  if (['caba', 'capital federal', 'ciudad de buenos aires', 'ciudad autonoma buenos aires', 'ciudad autonoma de buenos aires'].includes(key)) return 'ciudad autonoma de buenos aires'
  if (key.startsWith('tierra del fuego')) return 'tierra del fuego'
  return key
}

function allPositions(value: unknown): GeoPosition[] {
  if (!Array.isArray(value)) return []
  if (typeof value[0] === 'number' && typeof value[1] === 'number') return [value as GeoPosition]
  return value.flatMap(allPositions)
}

function isMainSouthernIsland(value: unknown) {
  const positions = allPositions(value)
  if (!positions.length) return false
  const longitudes = positions.map(([longitude]) => longitude)
  const latitudes = positions.map(([, latitude]) => latitude)
  const minLongitude = Math.min(...longitudes), maxLongitude = Math.max(...longitudes)
  const minLatitude = Math.min(...latitudes), maxLatitude = Math.max(...latitudes)
  const longitudeSpan = maxLongitude - minLongitude
  const latitudeSpan = maxLatitude - minLatitude

  // Keep Isla Grande de Tierra del Fuego and the two principal Malvinas islands.
  const tierraDelFuego = minLongitude > -70 && maxLongitude < -64
    && minLatitude > -56 && maxLatitude < -52
    && longitudeSpan > 2.5 && latitudeSpan > 2
  const malvinas = minLongitude > -62 && maxLongitude < -57
    && minLatitude > -53 && maxLatitude < -50
    && longitudeSpan > 1.5 && latitudeSpan > .8
  return tierraDelFuego || malvinas
}

function geometryPath(value: unknown, project: (position: GeoPosition) => [number, number]): string {
  if (!Array.isArray(value)) return ''
  if (value.length > 2 && Array.isArray(value[0]) && typeof value[0][0] === 'number') {
    const points = (value as GeoPosition[]).map(project)
    return `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`
  }
  return value.map((child) => geometryPath(child, project)).join('')
}

function interpolateBlue(amount: number) {
  const light = [184, 228, 242], dark = [29, 95, 145]
  const t = Math.min(1, Math.max(0, amount))
  return `rgb(${light.map((channel, index) => Math.round(channel + (dark[index] - channel) * t)).join(',')})`
}

function ProvinceMap({ data, metric }: { data: ProvinceMetric[]; metric: MapMetric }) {
  const [collection, setCollection] = useState<ProvinceFeatureCollection | null>(null)
  const [mapError, setMapError] = useState(false)
  useEffect(() => {
    const url = new URL('./data/provincias.geojson', import.meta.url)
    fetch(url).then((response) => {
      if (!response.ok) throw new Error('No se pudo cargar el mapa.')
      return response.json() as Promise<ProvinceFeatureCollection>
    }).then(setCollection).catch(() => setMapError(true))
  }, [])

  const projectedFeatures = useMemo(() => {
    if (!collection) return []
    const features = collection.features.map((feature) => {
      let coordinates = feature.geometry.coordinates
      if (feature.properties.nombre.startsWith('Tierra del Fuego') && Array.isArray(coordinates)) {
        // The IGN multipolygon also includes Antarctica and many small islands.
        // Keep only Isla Grande de Tierra del Fuego and the principal Malvinas islands.
        coordinates = coordinates.filter(isMainSouthernIsland)
      }
      return { feature, coordinates }
    })
    const positions = features.flatMap(({ coordinates }) => allPositions(coordinates))
    if (!positions.length) return []
    const bounds = positions.reduce((result, [longitude, latitude]) => ({
      minLon: Math.min(result.minLon, longitude), maxLon: Math.max(result.maxLon, longitude),
      minLat: Math.min(result.minLat, latitude), maxLat: Math.max(result.maxLat, latitude),
    }), { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity })
    const { minLon, maxLon, minLat, maxLat } = bounds
    const width = 420, height = 610, padding = 12
    const scale = Math.min((width - padding * 2) / (maxLon - minLon), (height - padding * 2) / (maxLat - minLat))
    const offsetX = (width - (maxLon - minLon) * scale) / 2
    const offsetY = (height - (maxLat - minLat) * scale) / 2
    const project = ([longitude, latitude]: GeoPosition): [number, number] => [
      offsetX + (longitude - minLon) * scale,
      offsetY + (maxLat - latitude) * scale,
    ]
    return features.map(({ feature, coordinates }) => ({
      name: feature.properties.nombre,
      path: geometryPath(coordinates, project),
    }))
  }, [collection])

  const metricByProvince = new Map(data.map((item) => [provinceKey(item.province), item]))
  // Ignore fields missing from an older API container as well as null/invalid rates.
  const values = data.map((item) => item[metric]).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  const minimum = Math.min(...values), maximum = Math.max(...values)
  if (mapError) return <div className="map-empty">No se pudo cargar el mapa de provincias.</div>
  if (!projectedFeatures.length) return <div className="map-empty"><span className="spinner dark" /> Preparando mapa…</div>

  return <div className="province-map-wrap">
    <svg className="province-map" viewBox="0 0 420 610" role="img" aria-label="Mapa de Argentina por provincia">
      {projectedFeatures.map((feature) => {
        const point = metricByProvince.get(provinceKey(feature.name))
        const value = point?.[metric] ?? null
        const fill = value === null ? '#e6edf2' : interpolateBlue(maximum === minimum ? .55 : (value - minimum) / (maximum - minimum))
        return <path key={feature.name} d={feature.path} fill={fill} className="province-shape">
          <title>{feature.name}: {value === null ? 'sin datos' : formatPercent(value)}</title>
        </path>
      })}
    </svg>
    {!values.length && <p className="map-no-values">No hay tasas disponibles. Verificá que la API esté actualizada y que se hayan importado la población anual y los porcentajes de edad escolar.</p>}
    <div className="map-legend"><span>{values.length ? formatPercent(minimum) : '—'}</span><div className="legend-gradient"/><span>{values.length ? formatPercent(maximum) : '—'}</span><small>Menor</small><small>Mayor</small></div>
  </div>
}

function ProvinceDetailList({ data, metric }: { data: ProvinceMetric[]; metric: MapMetric }) {
  const geoNames: string[] = [
    'Buenos Aires', 'Catamarca', 'Chaco', 'Chubut', 'Ciudad Autónoma de Buenos Aires', 'Córdoba', 'Corrientes',
    'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro',
    'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
    'Tierra del Fuego, Antártida e Islas del Atlántico Sur', 'Tucumán',
  ]
  const lookup = new Map(data.map((item) => [provinceKey(item.province), item]))
  const rows = geoNames.map((name) => ({ name, item: lookup.get(provinceKey(name)) ?? null }))
    .sort((a, b) => (b.item?.[metric] ?? -1) - (a.item?.[metric] ?? -1) || a.name.localeCompare(b.name, 'es'))

  function headline(item: ProvinceMetric | null) {
    if (!item) return 'Sin datos'
    const value = item[metric]
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Sin base para calcular'
    return formatPercent(value)
  }
  function detail(item: ProvinceMetric | null) {
    if (!item) return 'No hay observaciones para esta provincia.'
    if (metric === 'enrollment_rate') {
      if (typeof item.enrolled !== 'number' || !Number.isFinite(item.enrolled)) return 'Sin dato de matrícula inicial'
      if (typeof item.school_age_population !== 'number' || !Number.isFinite(item.school_age_population) || item.school_age_population === 0) return `Matrícula inicial ${formatNumber(item.enrolled)} · sin población en edad escolar de referencia`
      return `${formatNumber(item.enrolled)} matriculados · población 4–17 años ${formatNumber(item.school_age_population)}`
    }
    if (metric === 'promotion_rate') return `${formatNumber(item.promoted ?? 0)} promovidos · base ${formatNumber((item.promoted ?? 0) + (item.not_promoted ?? 0))}`
    if (metric === 'not_promotion_rate') return `${formatNumber(item.not_promoted ?? 0)} no promovidos · base ${formatNumber((item.promoted ?? 0) + (item.not_promoted ?? 0))}`
    return `${formatNumber(item.exits_without_transfer ?? 0)} salidos sin pase · matrícula inicial ${formatNumber(item.enrolled ?? 0)}`
  }

  return <div className="province-list">
    {rows.map(({ name, item }) => <article className="province-list-row" key={name}>
      <div className="province-list-main"><span className="province-list-name">{name}</span><strong>{headline(item)}</strong></div>
      <p>{detail(item)}</p>
    </article>)}
  </div>
}

function EqualityBarCard({ title, subtitle, data, colors }: { title: string; subtitle: string; data: EqualityPoint[]; colors: string[] }) {
  return <article className="chart-card equality-chart-card">
    <div className="chart-heading"><div><h3>{title}</h3><p>{subtitle}</p></div></div>
    <div className="equality-bars">
      {data.map((item, index) => <div className="equality-bar-row" key={item.label}>
        <span className="equality-bar-label">{item.label}</span>
        <div className="bar-track"><div className="bar-fill" style={{ width: `${item.rate === null ? 0 : Math.max(item.rate, 0)}%`, background: colors[index] }} /></div>
        <strong>{item.rate === null ? 'Sin datos' : formatPercent(item.rate)}</strong>
      </div>)}
    </div>
    <div className="equality-axis"><span>0%</span><span>50%</span><span>100%</span></div>
  </article>
}

function AboutPage() {
  return <section className="about-page">
    <div className="eyebrow"><span className="eyebrow-dot" /> INFORMACIÓN DEL SISTEMA</div>
    <h1>Acerca de <span>la plataforma</span></h1>
    <p className="about-lead">Una herramienta para organizar y explorar información sobre trayectorias educativas en Argentina.</p>

    <article className="about-source">
      <div className="about-source-icon">↗</div>
      <div><span className="section-kicker">ORIGEN DE LOS DATOS</span><h2>Relevamiento Anual de Educación</h2>
        <p>El proyecto trabaja con bases usuarias por escuela del Relevamiento Anual (RA), producido por la Secretaría de Educación de la Nación. El RA es un relevamiento censal anual del sistema educativo, su base de trayectoria incluye alumnos promovidos, no promovidos y salidos, con desgloses por establecimiento, jurisdicción, sector, ámbito, oferta y sexo. Los archivos se incorporan manualmente: la plataforma no los descarga de Nación.</p>
        <div className="source-links"><a href="https://www.argentina.gob.ar/capital-humano/estadisticas-educativas" target="_blank" rel="noreferrer">Estadísticas educativas nacionales ↗</a><a href="https://www.argentina.gob.ar/sites/default/files/diccionario_de_datos.pdf" target="_blank" rel="noreferrer">Diccionario de las bases usuarias ↗</a></div>
      </div>
    </article>

    <div className="about-section-heading"><span className="section-kicker">QUÉ SE ANALIZA</span><h2>Dimensiones de la trayectoria</h2><p>El procesador convierte las columnas reconocidas en observaciones para facilitar su consulta y comparación.</p></div>
    <div className="about-grid">
      <article className="about-card"><span className="about-number">01</span><h3>Territorio</h3><p>Los datos están referenciados por provincia y departamento. Cuando están presentes, también se guardan sector (privado/público) y ámbito (urbano/rural).</p><div className="tag-row"><span>Provincia</span><span>Departamento</span><span>Sector</span><span>Ámbito</span></div></article>
      <article className="about-card"><span className="about-number">02</span><h3>Indicadores educativos</h3><p>Se reconocen columnas vinculadas con promoción, no promoción, regularidad, entradas, sobreedad, nivel inicial y egresos.</p><div className="tag-row"><span>Promoción</span><span>Regularidad</span><span>Egresos</span></div></article>
      <article className="about-card"><span className="about-number">03</span><h3>Año de estudio</h3><p>Se separan los datos por año cursado, teniendo en cuenta primaria y secundaria.</p><div className="tag-row"><span>Año cursado</span><span>Grupo de años</span><span>Categorías especiales</span></div></article>
      <article className="about-card"><span className="about-number">04</span><h3>Sexo</h3><p>Para cada medición, se especifica el total de todos los sexos, y el total de mujeres, permitiendo distinguir por género.</p><div className="tag-row"><span>Total</span><span>Mujeres</span></div></article>
    </div>
  </section>
}

export default function App() {
  const [section, setSection] = useState<Section>(() => sectionFromPath(window.location.hash.replace(/^#/, '')))
  function navigate(next: Section) {
    setSection(next)
    if (window.location.hash !== `#${SECTION_PATHS[next]}`) window.location.hash = SECTION_PATHS[next]
  }
  useEffect(() => {
    const syncRoute = () => setSection(sectionFromPath(window.location.hash.replace(/^#/, '')))
    window.addEventListener('hashchange', syncRoute)
    return () => window.removeEventListener('hashchange', syncRoute)
  }, [])
  const [uploadYear, setUploadYear] = useState(String(new Date().getFullYear()))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [years, setYears] = useState<AvailableYear[]>([])
  const [selectedYear, setSelectedYear] = useState('')
  const [equalityYear, setEqualityYear] = useState('')
  const [equalityProvince, setEqualityProvince] = useState('Nación')
  const [equalityDepartment, setEqualityDepartment] = useState('')
  const [equalityStats, setEqualityStats] = useState<EqualityStatistics | null>(null)
  const [equalityLoading, setEqualityLoading] = useState(false)
  const [equalityError, setEqualityError] = useState('')
  const [mapMetric, setMapMetric] = useState<MapMetric>('enrollment_rate')
  const [provinceMetrics, setProvinceMetrics] = useState<ProvinceMetric[]>([])
  const [mapRefreshKey, setMapRefreshKey] = useState(0)
  const [statsError, setStatsError] = useState('')
  const [loadingStats, setLoadingStats] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  async function refreshYears(preferredYear?: number) {
    try {
      const response = await fetch('/api/statistics/years')
      if (!response.ok) throw new Error('No se pudieron cargar los años disponibles.')
      const available = await response.json() as AvailableYear[]
      setYears(available)
      if (available.length) {
        const nextYear = preferredYear && available.some((item) => item.year === preferredYear)
          ? String(preferredYear)
          : selectedYear && available.some((item) => String(item.year) === selectedYear)
            ? selectedYear : String(available[0].year)
        setSelectedYear(nextYear)
        setEqualityYear((current) => current && available.some((item) => String(item.year) === current) ? current : String(available[0].year))
      } else {
        setSelectedYear('')
        setEqualityYear('')
        setProvinceMetrics([])
      }
      setStatsError('')
    } catch (reason) {
      setStatsError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
    }
  }

  useEffect(() => { void refreshYears() }, [])

  useEffect(() => {
    if (!selectedYear) { setLoadingStats(false); return }
    const controller = new AbortController()
    async function load() {
      setLoadingStats(true)
      setStatsError('')
      try {
        const params = new URLSearchParams({ year: selectedYear })
        const response = await fetch(`/api/statistics/province-map?${params}`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail ?? 'No se pudieron cargar las estadísticas por provincia.')
        setProvinceMetrics(data.provinces as ProvinceMetric[])
      } catch (reason) {
        if (reason instanceof Error && reason.name === 'AbortError') return
        setStatsError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
      } finally {
        if (!controller.signal.aborted) setLoadingStats(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [selectedYear, mapRefreshKey])

  useEffect(() => {
    if (!equalityYear) return
    const controller = new AbortController()
    async function loadEquality() {
      setEqualityLoading(true)
      setEqualityError('')
      const params = new URLSearchParams({ year: equalityYear })
      if (equalityProvince !== 'Nación') params.set('province', equalityProvince)
      if (equalityDepartment) params.set('department', equalityDepartment)
      try {
        const response = await fetch(`/api/statistics/equality?${params}`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail ?? 'No se pudieron cargar los datos de igualdad.')
        setEqualityStats(data as EqualityStatistics)
      } catch (reason) {
        if (reason instanceof Error && reason.name === 'AbortError') return
        setEqualityError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
        setEqualityStats(null)
      } finally {
        if (!controller.signal.aborted) setEqualityLoading(false)
      }
    }
    void loadEquality()
    return () => controller.abort()
  }, [equalityYear, equalityProvince, equalityDepartment, mapRefreshKey])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setUploadError('')
    setResult(null)
    const body = new FormData()
    body.append('year', uploadYear)
    body.append('file', file)
    try {
      const response = await fetch('/api/imports', { method: 'POST', body })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail ?? 'No se pudo procesar el archivo.')
      setResult(data as ImportResult)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
      setMapRefreshKey((key) => key + 1)
      await refreshYears(Number(uploadYear))
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
    } finally {
      setBusy(false)
    }
  }

  const selectedMetric = MAP_METRICS.find((item) => item.id === mapMetric) ?? MAP_METRICS[0]
  const selectedFile = years.find((item) => String(item.year) === selectedYear)?.file_name
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <a className="brand" href="#inicio" aria-label="Radar Educativo, inicio">
          <span className="brand-mark" aria-hidden="true">
            <img src="/radar-educativo.svg" alt="" />
          </span><span><b>Radar Educativo</b></span>
        </a>
        <div className="sidebar-caption">MENÚ PRINCIPAL</div>
        <nav className="side-nav" aria-label="Navegación principal">
          <button className={section === 'summary' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('summary')} aria-current={section === 'summary' ? 'page' : undefined}>
            <NavIcon kind="chart" /> Trayectorias
          </button>
          <button className={section === 'equality' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('equality')} aria-current={section === 'equality' ? 'page' : undefined}>
            <NavIcon kind="scale" /> Igualdad
          </button>
          <button className={section === 'predictive' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('predictive')} aria-current={section === 'predictive' ? 'page' : undefined}>
            <NavIcon kind="sparkle" /> Predictivo
          </button>
          <button className={section === 'reports' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('reports')} aria-current={section === 'reports' ? 'page' : undefined}>
            <NavIcon kind="document" /> Reportes
          </button>
          <button className={section === 'upload' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('upload')}>
            <span className="nav-icon">↑</span> Subir archivo
          </button>
          <button className={section === 'about' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('about')}>
            <span className="nav-icon">ⓘ</span> Acerca de
          </button>
        </nav>
        <div className="sidebar-bottom"><span className="status-dot" /> SISTEMA DE DATOS EDUCATIVOS</div>
      </aside>

      <main className="main-area">
        <header className="topbar"><span className="topbar-label">Radar Educativo</span><span className="country-tag">ARGENTINA <span>●</span></span></header>

        {section === 'upload' ? <section className="content upload-content" id="inicio">
          <div className="eyebrow"><span className="eyebrow-dot" /> DATOS EDUCATIVOS · ARGENTINA</div>
          <h1>Importar trayectoria<br /><span>educativa</span></h1>
          <p className="intro">Cargá un dataset anual para procesar y guardar sus observaciones en la base del sistema.</p>

          <form className="upload-card" onSubmit={submit}>
            <div className="card-heading"><div><h2>Nueva importación</h2><p>Completá el año y seleccioná el archivo de origen.</p></div><div className="step-number">01 <span>/ 01</span></div></div>
            <label className="field-label" htmlFor="upload-year">Año del dataset</label>
            <div className="year-wrap"><span className="calendar-icon" aria-hidden="true">▦</span>
              <input id="upload-year" type="number" min="1900" max="2100" required value={uploadYear} onChange={(event) => setUploadYear(event.target.value)} />
              <span className="input-suffix">AÑO</span>
            </div>
            <label className="field-label file-label" htmlFor="dataset">Archivo de datos</label>
            <label className={`dropzone ${file ? 'has-file' : ''}`} htmlFor="dataset">
              <input ref={inputRef} id="dataset" type="file" accept=".csv,.txt,.xlsx,.xls" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              <span className="upload-icon" aria-hidden="true">↑</span>
              <span className="drop-title">{file ? file.name : 'Arrastrá tu archivo o hacé clic para buscar'}</span>
              <span className="drop-meta">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · listo para importar` : 'Formatos admitidos: CSV, TXT, XLSX o XLS'}</span>
            </label>
            {uploadError && <div className="notice error" role="alert">{uploadError}</div>}
            {result && <div className="notice success" role="status">{result.message} Se guardaron {result.rows_processed.toLocaleString('es-AR')} observaciones. Importación #{result.import_id}.</div>}
            <button className="submit-button" type="submit" disabled={!file || busy}>
              {busy ? <><span className="spinner" /> Procesando archivo…</> : <>Procesar e importar <span aria-hidden="true">→</span></>}
            </button>
            <p className="privacy-note"><span aria-hidden="true">⌑</span> Los datos se procesan y almacenan en la base del sistema.</p>
          </form>
          <footer className="page-footer"><span>PLATAFORMA DE SOPORTE A DECISIONES</span><span>EDUCACIÓN · ARGENTINA</span></footer>
        </section> : section === 'about' ? <AboutPage /> : section === 'equality' ? <section className="dashboard">
          <div className="dashboard-title-row equality-title-row">
            <div><div className="eyebrow"><span className="eyebrow-dot" /> PANEL DE ANÁLISIS</div><h1>Igualdad</h1><p className="intro">Compará las tasas de promoción según sexo y ámbito.</p></div>
            <div className="equality-filters">
              <label className="dashboard-year"><span>AÑO DEL DATASET</span><select value={equalityYear} onChange={(event) => { setEqualityYear(event.target.value); setEqualityDepartment('') }} disabled={!years.length}>
                {years.map((item) => <option key={item.year} value={item.year}>{item.year}</option>)}
              </select></label>
              <label className="dashboard-year"><span>PROVINCIA</span><select value={equalityProvince} onChange={(event) => { setEqualityProvince(event.target.value); setEqualityDepartment('') }} disabled={!years.length}>
                <option value="Nación">Nación</option>
                {(equalityStats?.provinces ?? []).map((province) => <option key={province} value={province}>{province}</option>)}
              </select></label>
              <label className="dashboard-year"><span>DEPARTAMENTO</span><select value={equalityDepartment} onChange={(event) => setEqualityDepartment(event.target.value)} disabled={equalityProvince === 'Nación' || !equalityStats?.departments.length}>
                <option value="">Todos</option>
                {(equalityStats?.departments ?? []).map((department) => <option key={department} value={department}>{department}</option>)}
              </select></label>
            </div>
          </div>
          {equalityError && <div className="notice error" role="alert">{equalityError}</div>}
          {equalityLoading ? <div className="loading-panel"><span className="spinner dark" /> Cargando datos de igualdad…</div>
            : equalityStats && <div className="equality-charts-grid">
              <EqualityBarCard title="Tasa de promoción por sexo" subtitle="Hombres y mujeres · porcentaje" data={equalityStats.by_sex} colors={['#3977bb', '#d66b9b']} />
              <EqualityBarCard title="Tasa de promoción por ámbito" subtitle="Urbano y rural · porcentaje" data={equalityStats.by_area} colors={['#e88b32', '#588b52']} />
            </div>}
          <p className="data-note">Tasa de promoción = promovidos / (promovidos + no promovidos). El valor de hombres se calcula restando mujeres al total, según las columnas disponibles en los datos.</p>
        </section> : section === 'predictive' || section === 'reports' ? <section className="dashboard">
          <div className="dashboard-placeholder">
            <div className="eyebrow"><span className="eyebrow-dot" /> PANEL DE ANÁLISIS</div>
            <h1>{section === 'predictive' ? 'Predictivo' : 'Reportes'}</h1>
            <p className="intro">{section === 'predictive'
              ? 'Seleccioná Nación o una provincia para consultar la predicción de la tasa de no promoción.'
              : 'Generá informes que integren la información de trayectorias, igualdad y predicciones en un documento.'}</p>
            <div className="coming-soon"><span className="empty-icon">{section === 'predictive' ? '✦' : '▤'}</span><h2>En preparación</h2><p>Esta página se completará en una próxima etapa.</p></div>
          </div>
        </section> : <section className="dashboard">
          <div className="dashboard-title-row">
            <div><div className="eyebrow"><span className="eyebrow-dot" /> PANEL DE ANÁLISIS</div><h1>Trayectorias</h1><p className="intro">Explorá los principales datos de trayectoria educativa.</p></div>
            <label className="dashboard-year"><span>AÑO DEL DATASET</span><select value={selectedYear} onChange={(event) => setSelectedYear(event.target.value)} disabled={!years.length}>
              {years.length ? years.map((item) => <option key={item.year} value={item.year}>{item.year}</option>) : <option value="">Sin datos</option>}
            </select></label>
          </div>

          {statsError && <div className="notice error" role="alert">{statsError}</div>}
          {loadingStats && years.length > 0 ? <div className="loading-panel"><span className="spinner dark" /> Cargando estadísticas…</div>
            : !years.length && !statsError ? <div className="empty-panel"><span className="empty-icon">▤</span><h2>Todavía no hay datos cargados</h2><p>Subí un archivo de trayectoria para empezar a explorar las estadísticas.</p><button className="secondary-button" onClick={() => navigate('upload')}>Ir a subir archivo →</button></div>
              : years.length > 0 && <>
                <div className="data-source"><span>Importación seleccionada</span><b>{selectedFile ?? `Año ${selectedYear}`}</b></div>
                <div className="metric-switcher" role="group" aria-label="Elegir indicador">
                  {MAP_METRICS.map((item) => <button type="button" key={item.id} className={mapMetric === item.id ? 'metric-option active' : 'metric-option'} aria-pressed={mapMetric === item.id} onClick={() => setMapMetric(item.id)}>{item.label}</button>)}
                </div>
                <div className="metric-heading"><div><h2>{selectedMetric.label}</h2><p>{selectedMetric.description}</p></div><span>TASA</span></div>
                <div className="territory-layout">
                  <article className="map-panel">
                    <div className="panel-heading"><div><h3>Por provincia</h3><p>Seleccioná un tono para comparar territorios</p></div><span className="panel-icon">⌖</span></div>
                    <ProvinceMap data={provinceMetrics} metric={mapMetric} />
                  </article>
                  <article className="province-list-panel">
                    <div className="panel-heading"><div><h3>Detalle por provincia</h3><p>Ordenado de mayor a menor</p></div><span className="panel-count">{provinceMetrics.length}/24</span></div>
                    <ProvinceDetailList data={provinceMetrics} metric={mapMetric} />
                  </article>
                </div>
                <p className="methodology-note"><strong>Cómo se calcula:</strong> matrícula relativa = matrícula inicial / población estimada de 4 a 17 años. La población en edad escolar se estima aplicando a la población departamental anual el porcentaje de 4 a 17 años del Censo 2022, que se mantiene constante para todos los años. Promoción = promovidos / (promovidos + no promovidos); no promoción usa la misma base. Para abandono se usa “salidos sin pase” / matrícula inicial como referencia exploratoria: no equivale a la tasa oficial de abandono interanual. Los numeradores provienen de valores absolutos del archivo.</p>
              </>}
        </section>}
      </main>
    </div>
  )
}
