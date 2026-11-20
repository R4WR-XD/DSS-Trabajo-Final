import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'

type ImportResult = {
  import_id: number
  file_name: string
  year: number
  rows_processed: number
  message: string
}
type AvailableYear = { year: number; import_id: number; file_name: string }
type PredictionResult = {
  eligible: boolean
  year: number
  available_years: number[]
  required_years: number
  message?: string
  province?: string
  area?: string
  sex?: string
  history?: Array<{ year: number; rate: number; imputed: boolean }>
  forecast?: number
  forecast_series?: Array<{ year: number; rate: number }>
  forecast_steps?: number
  model?: string
  imputed_year?: number | null
}
type MapMetric = 'enrollment_rate' | 'promotion_rate' | 'not_promotion_rate' | 'abandonment_rate'
type TerritoryMetric = {
  name: string
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
type ProvinceMetric = TerritoryMetric
type GeoPosition = [number, number, ...number[]]
type TerritoryFeature = {
  type: 'Feature'
  properties: { nombre: string; provincia?: { nombre?: string } | string; [key: string]: unknown }
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }
}
type TerritoryFeatureCollection = { type: 'FeatureCollection'; features: TerritoryFeature[] }
type EqualityPoint = { label: string; rate: number | null }
type StudyYearPoint = {
  study_year: number
  label: string
  level: 'Primaria' | 'Secundaria'
  value: number | null
  amount: number | null
}
type EqualityStatistics = {
  provinces: string[]
  departments: string[]
  by_sex: EqualityPoint[]
  by_area: EqualityPoint[]
}

type Section = 'summary' | 'equality' | 'predictive' | 'reports' | 'upload'
const SECTION_PATHS: Record<Section, string> = {
  summary: '/trayectorias', equality: '/igualdad', predictive: '/predictivo', reports: '/reportes', upload: '/subir-archivo',
}
type AppRoute = { section: Section; provinceSlug?: string; year?: string; indicator?: string }
function readRoute(): AppRoute {
  const [path, query = ''] = window.location.hash.replace(/^#/, '').split('?')
  const segments = path.split('/').filter(Boolean)
  const sectionPath = `/${segments[0] ?? 'trayectorias'}`
  const section = (Object.entries(SECTION_PATHS).find(([, route]) => route === sectionPath)?.[0] as Section | undefined) ?? 'summary'
  const params = new URLSearchParams(query)
  return { section, provinceSlug: section === 'summary' ? segments[1] : undefined, year: params.get('year') ?? undefined, indicator: params.get('indicator') ?? undefined }
}

const PROVINCE_NAMES = [
  'Buenos Aires', 'Catamarca', 'Chaco', 'Chubut', 'Ciudad Autónoma de Buenos Aires', 'Córdoba', 'Corrientes',
  'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro',
  'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego, Antártida e Islas del Atlántico Sur', 'Tucumán',
]

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
  { id: 'enrollment_rate', label: 'Matrícula', description: 'Matrícula inicial sobre población estimada de 4 a 17 años' },
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

function provinceSlug(name: string) {
  return provinceKey(name).replace(/\s+/g, '-')
}

function provinceForSlug(slug?: string) {
  return PROVINCE_NAMES.find((name) => provinceSlug(name) === slug) ?? null
}

function departmentKey(name: string) {
  const key = name.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  const aliases: Record<string, string> = {
    ...Object.fromEntries(Array.from({ length: 15 }, (_, index) => [String(index + 1), `comuna ${index + 1}`])),
    'angel vicente penaloza': 'general angel v penaloza',
    'coronel felipe varela': 'general felipe varela',
    'general juan f quiroga': 'general juan facundo quiroga',
    'general ocampo': 'general ortiz de ocampo',
    'la capital': 'juan martin de pueyrredon',
    'juan f ibarra': 'juan felipe ibarra',
    'juan b alberdi': 'juan bautista alberdi',
  }
  return aliases[key] ?? key
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

function TerritoryMap({
  data,
  metric,
  level,
  province,
  onProvinceSelect,
}: {
  data: TerritoryMetric[]
  metric: MapMetric
  level: 'province' | 'department'
  province?: string
  onProvinceSelect?: (province: string) => void
}) {
  const [collection, setCollection] = useState<TerritoryFeatureCollection | null>(null)
  const [mapError, setMapError] = useState(false)
  useEffect(() => {
    const url = new URL(level === 'province' ? './data/provincias.geojson' : './data/departamentos.geojson', import.meta.url)
    fetch(url).then((response) => {
      if (!response.ok) throw new Error('No se pudo cargar el mapa.')
      return response.json() as Promise<TerritoryFeatureCollection>
    }).then((result) => { setCollection(result); setMapError(false) }).catch(() => setMapError(true))
  }, [level])

  const projectedFeatures = useMemo(() => {
    if (!collection) return []
    const matchingFeatures = collection.features.filter((feature) => {
      if (level === 'province') return true
      const featureProvince = typeof feature.properties.provincia === 'string'
        ? feature.properties.provincia
        : feature.properties.provincia?.nombre ?? ''
      if (provinceKey(featureProvince) !== provinceKey(province ?? '')) return false
      if (provinceKey(province ?? '') === 'tierra del fuego') {
        const departmentName = departmentKey(feature.properties.nombre)
        if (departmentName === 'antartida argentina' || departmentName === 'islas del atlantico sur') return false
      }
      return true
    })
    const features = matchingFeatures.map((feature) => {
      let coordinates = feature.geometry.coordinates
      if (level === 'province' && feature.properties.nombre.startsWith('Tierra del Fuego') && Array.isArray(coordinates)) {
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
  }, [collection, level, province])

  const keyForName = level === 'province' ? provinceKey : departmentKey
  const metricByTerritory = new Map(data.map((item) => [keyForName(item.name), item]))
  // Ignore fields missing from an older API container as well as null/invalid rates.
  const values = data.map((item) => item[metric]).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  ).map((value) => metric === 'enrollment_rate' ? Math.min(value, 100) : value)
  const minimum = Math.min(...values), maximum = Math.max(...values)
  if (mapError) return <div className="map-empty">No se pudo cargar el mapa de provincias.</div>
  if (!projectedFeatures.length) return <div className="map-empty">No hay geometrías territoriales para mostrar.</div>

  return <div className="province-map-wrap">
    <svg className="province-map" viewBox="0 0 420 610" role="img" aria-label={level === 'province' ? 'Mapa de Argentina por provincia' : `Mapa departamental de ${province}`}>
      {projectedFeatures.map((feature) => {
        const point = metricByTerritory.get(keyForName(feature.name))
        const rawValue = point?.[metric] ?? null
        const value = rawValue !== null && metric === 'enrollment_rate' ? Math.min(rawValue, 100) : rawValue
        const fill = value === null ? '#e6edf2' : interpolateBlue(maximum === minimum ? .55 : (value - minimum) / (maximum - minimum))
        return <path
          key={feature.name}
          d={feature.path}
          fill={fill}
          className={onProvinceSelect ? 'province-shape province-shape-clickable' : 'province-shape'}
          onClick={onProvinceSelect ? () => onProvinceSelect(feature.name) : undefined}
          onKeyDown={onProvinceSelect ? (event) => { if (event.key === 'Enter' || event.key === ' ') onProvinceSelect(feature.name) } : undefined}
          role={onProvinceSelect ? 'button' : undefined}
          tabIndex={onProvinceSelect ? 0 : undefined}
        >
          <title>{feature.name}: {value === null ? 'sin datos' : formatPercent(value)}</title>
        </path>
      })}
    </svg>
    {!values.length && <p className="map-no-values">No hay tasas disponibles. Verificá que la API esté actualizada y que se hayan importado la población anual y los porcentajes de edad escolar.</p>}
    <div className="map-legend"><span>{values.length ? formatPercent(minimum) : '—'}</span><div className="legend-gradient"/><span>{values.length ? formatPercent(maximum) : '—'}</span><small>Menor</small><small>Mayor</small></div>
  </div>
}

function TerritoryDetailList({ data, metric, level }: { data: TerritoryMetric[]; metric: MapMetric; level: 'province' | 'department' }) {
  const names = level === 'province' ? PROVINCE_NAMES : data.map((item) => item.name)
  const keyForName = level === 'province' ? provinceKey : departmentKey
  const lookup = new Map(data.map((item) => [keyForName(item.name), item]))
  const rows = names.map((name) => ({ name, item: lookup.get(keyForName(name)) ?? null }))
    .sort((a, b) => (b.item?.[metric] ?? -1) - (a.item?.[metric] ?? -1) || a.name.localeCompare(b.name, 'es'))

  function headline(item: ProvinceMetric | null) {
    if (!item) return 'Sin datos'
    const value = item[metric]
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Sin base para calcular'
    return formatPercent(metric === 'enrollment_rate' ? Math.min(value, 100) : value)
  }
  function detail(item: ProvinceMetric | null) {
    if (!item) return 'No hay observaciones para esta provincia.'
    if (metric === 'enrollment_rate') {
      if (typeof item.enrolled !== 'number' || !Number.isFinite(item.enrolled)) return 'Sin dato de matrícula inicial'
      if (typeof item.school_age_population !== 'number' || !Number.isFinite(item.school_age_population) || item.school_age_population === 0) return `Matrícula inicial ${formatNumber(item.enrolled)} · sin población en edad escolar de referencia`
      return `${formatNumber(item.enrolled)} matriculados · población estimada de 4–17 años ${formatNumber(item.school_age_population)}`
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

function StudyYearHistogram({
  data,
  metric,
  territoryName,
  loading,
  error,
}: {
  data: StudyYearPoint[]
  metric: MapMetric
  territoryName: string
  loading: boolean
  error: string
}) {
  const values = data.map((point) => point.value).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const maximumValue = values.length ? Math.max(...values) : 0
  const axisMaximum = Math.max(10, Math.ceil(maximumValue / 10) * 10)
  const plot = { left: 45, right: 14, top: 22, bottom: 222 }
  const plotWidth = 680 - plot.left - plot.right
  const plotHeight = plot.bottom - plot.top
  const slotWidth = plotWidth / 12
  const barWidth = Math.min(29, slotWidth * .64)
  const title = metric === 'enrollment_rate' ? 'Distribución de matrícula por año de estudio' : `${MAP_METRICS.find((item) => item.id === metric)?.label ?? 'Indicador'} por año de estudio`
  const subtitle = metric === 'enrollment_rate'
    ? 'Participación de cada grado/año en la matrícula inicial total'
    : `Tasa seleccionada para ${territoryName.toLocaleLowerCase('es')}`

  return <article className="study-year-panel chart-card">
    <div className="chart-heading"><div><h3>{title}</h3><p>{subtitle}</p></div></div>
    {loading ? <div className="chart-empty"><span className="spinner dark" /> Calculando distribución…</div>
      : error ? <div className="chart-empty">{error}</div>
        : !values.length ? <div className="chart-empty">No hay valores para los años de estudio regulares.</div>
          : <svg className="study-year-chart" viewBox="0 0 680 290" role="img" aria-label={title}>
            {Array.from({ length: 5 }, (_, index) => {
              const tick = axisMaximum * (4 - index) / 4
              const y = plot.top + plotHeight * index / 4
              return <g key={tick}>
                <line x1={plot.left} x2={680 - plot.right} y1={y} y2={y} className="study-year-gridline" />
                <text x={plot.left - 8} y={y + 4} textAnchor="end" className="study-year-axis-label">{Math.round(tick)}%</text>
              </g>
            })}
            {data.map((point, index) => {
              const value = point.value
              const barHeight = value === null ? 0 : Math.max(0, value / axisMaximum * plotHeight)
              const x = plot.left + slotWidth * index + (slotWidth - barWidth) / 2
              const y = plot.bottom - barHeight
              const shortLabel = point.study_year <= 6 ? `${point.study_year}°G` : `${point.study_year - 6}°A`
              return <g key={point.study_year}>
                {value !== null && <>
                  <rect x={x} y={y} width={barWidth} height={barHeight} rx="3" className="study-year-bar">
                    <title>{point.label}: {formatPercent(value)}</title>
                  </rect>
                  <text x={x + barWidth / 2} y={Math.max(plot.top + 11, y - 5)} textAnchor="middle" className="study-year-value">{formatPercent(value)}</text>
                </>}
                <text x={x + barWidth / 2} y={plot.bottom + 18} textAnchor="middle" className="study-year-axis-label">{shortLabel}</text>
              </g>
            })}
            <line x1={plot.left + slotWidth * 6} x2={plot.left + slotWidth * 6} y1={plot.top} y2={plot.bottom + 26} className="study-year-separator" />
            <text x={plot.left + slotWidth * 3} y="272" textAnchor="middle" className="study-year-group-label">Primaria · 1° a 6° grado</text>
            <text x={plot.left + slotWidth * 9} y="272" textAnchor="middle" className="study-year-group-label">Secundaria · 1° a 6° año</text>
          </svg>}
  </article>
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

function PredictionChart({ data, year, forecasts }: { data: NonNullable<PredictionResult['history']>; year: number; forecasts: NonNullable<PredictionResult['forecast_series']> }) {
  const points = [...data.map((item) => ({ year: item.year, rate: item.rate, imputed: item.imputed, forecast: false })), ...forecasts.map((item) => ({ ...item, imputed: false, forecast: true }))]
  const minYear = Math.min(...points.map((point) => point.year)), maxYear = Math.max(...points.map((point) => point.year))
  const minRate = Math.min(...points.map((point) => point.rate)), maxRate = Math.max(...points.map((point) => point.rate))
  const spread = Math.max(1, maxRate - minRate)
  const x = (value: number) => 64 + (value - minYear) / Math.max(1, maxYear - minYear) * 628
  const y = (value: number) => 220 - (value - (minRate - spread * .15)) / (spread * 1.3) * 180
  const yTicks = Array.from({ length: 5 }, (_, index) => minRate - spread * .15 + (spread * 1.3) * index / 4).reverse()
  const line = points.map((point) => `${x(point.year)},${y(point.rate)}`).join(' ')
  return <div className="prediction-chart-wrap"><svg className="prediction-chart" viewBox="0 0 720 290" role="img" aria-label={`Histórico y predicción de la tasa de no promoción para ${year}`}>
    <text x="12" y="130" textAnchor="middle" className="prediction-axis-title" transform="rotate(-90 12 130)">Tasa de no promoción (%)</text>
    {yTicks.map((tick) => <g key={tick}><line x1="64" y1={y(tick)} x2="692" y2={y(tick)} stroke="#e5edf2" /><text x="58" y={y(tick) + 4} textAnchor="end" className="prediction-axis-label">{new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(tick)}%</text></g>)}
    <line x1="64" y1="220" x2="692" y2="220" stroke="#d5e1e9" />
    <polyline points={line} fill="none" stroke="#1d5f91" strokeWidth="3" strokeLinejoin="round" />
    {points.map((point) => <g key={point.year}><circle cx={x(point.year)} cy={y(point.rate)} r={point.year === year ? 6 : 4.5} fill={point.forecast ? '#c28d00' : point.imputed ? '#fff' : '#1d5f91'} stroke={point.imputed ? '#c28d00' : point.forecast ? '#c28d00' : '#fff'} strokeWidth="2"><title>{point.year}: {formatPercent(point.rate)}{point.imputed ? ' (imputado)' : point.forecast ? ' (predicción)' : ''}</title></circle><text x={x(point.year)} y="245" textAnchor="middle" className="prediction-axis-label">{point.year}</text></g>)}
  </svg><div className="prediction-legend"><span><i /> Histórico</span><span><i className="imputed" /> Año imputado</span><span><i className="forecast" /> Predicción</span></div></div>
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(readRoute)
  const [section, setSection] = useState<Section>(route.section)
  function navigate(next: Section) {
    setSection(next)
    if (window.location.hash !== `#${SECTION_PATHS[next]}`) window.location.hash = SECTION_PATHS[next]
  }
  useEffect(() => {
    const syncRoute = () => {
      const nextRoute = readRoute()
      setRoute(nextRoute)
      setSection(nextRoute.section)
      if (nextRoute.year) setSelectedYear(nextRoute.year)
      if (nextRoute.indicator && MAP_METRICS.some((item) => item.id === nextRoute.indicator)) {
        setMapMetric(nextRoute.indicator as MapMetric)
      }
    }
    window.addEventListener('hashchange', syncRoute)
    return () => window.removeEventListener('hashchange', syncRoute)
  }, [])
  const [uploadYear, setUploadYear] = useState(String(new Date().getFullYear()))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [years, setYears] = useState<AvailableYear[]>([])
  const [predictionYear, setPredictionYear] = useState('')
  const [predictionProvince, setPredictionProvince] = useState('Nación')
  const [predictionResult, setPredictionResult] = useState<PredictionResult | null>(null)
  const [predictionLoading, setPredictionLoading] = useState(false)
  const [predictionError, setPredictionError] = useState('')
  const [selectedYear, setSelectedYear] = useState(route.year ?? '')
  const [equalityYear, setEqualityYear] = useState('')
  const [equalityProvince, setEqualityProvince] = useState('Nación')
  const [equalityDepartment, setEqualityDepartment] = useState('')
  const [equalityStats, setEqualityStats] = useState<EqualityStatistics | null>(null)
  const [equalityLoading, setEqualityLoading] = useState(false)
  const [equalityError, setEqualityError] = useState('')
  const [mapMetric, setMapMetric] = useState<MapMetric>(() =>
    MAP_METRICS.some((item) => item.id === route.indicator) ? route.indicator as MapMetric : 'enrollment_rate',
  )
  const [provinceMetrics, setProvinceMetrics] = useState<ProvinceMetric[]>([])
  const [departmentMetrics, setDepartmentMetrics] = useState<TerritoryMetric[]>([])
  const [studyYearPoints, setStudyYearPoints] = useState<StudyYearPoint[]>([])
  const [studyYearLoading, setStudyYearLoading] = useState(false)
  const [studyYearError, setStudyYearError] = useState('')
  const [mapRefreshKey, setMapRefreshKey] = useState(0)
  const [statsError, setStatsError] = useState('')
  const [loadingStats, setLoadingStats] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedProvince = provinceForSlug(route.provinceSlug)

  function navigateProvince(province: string) {
    const params = new URLSearchParams({ year: selectedYear, indicator: mapMetric })
    window.location.hash = `${SECTION_PATHS.summary}/${provinceSlug(province)}?${params.toString()}`
  }

  useEffect(() => {
    if (section !== 'summary' || !route.provinceSlug) return
    const params = new URLSearchParams()
    if (selectedYear) params.set('year', selectedYear)
    params.set('indicator', mapMetric)
    const nextHash = `#${SECTION_PATHS.summary}/${route.provinceSlug}?${params.toString()}`
    if (window.location.hash !== nextHash) window.location.hash = nextHash
  }, [section, route.provinceSlug, selectedYear, mapMetric])

  async function refreshYears(preferredYear?: number) {
    try {
      const response = await fetch('/api/statistics/years')
      if (!response.ok) throw new Error('No se pudieron cargar los años disponibles.')
      const available = await response.json() as AvailableYear[]
      setYears(available)
      if (available.length) {
        setPredictionYear((current) => current || String(Math.max(...available.map((item) => item.year)) + 1))
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
        setDepartmentMetrics([])
      }
      setStatsError('')
    } catch (reason) {
      setStatsError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
    }
  }

  useEffect(() => { void refreshYears() }, [])

  useEffect(() => {
    if (section !== 'predictive' || !predictionYear) return
    const controller = new AbortController()
    async function loadPrediction() {
      setPredictionLoading(true)
      setPredictionError('')
      const params = new URLSearchParams({ year: predictionYear })
      if (predictionProvince !== 'Nación') params.set('province', predictionProvince)
      try {
        const response = await fetch(`/api/predictions?${params}`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail ?? 'No se pudo calcular la predicción.')
        setPredictionResult(data as PredictionResult)
      } catch (reason) {
        if (reason instanceof Error && reason.name === 'AbortError') return
        setPredictionError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
        setPredictionResult(null)
      } finally {
        if (!controller.signal.aborted) setPredictionLoading(false)
      }
    }
    void loadPrediction()
    return () => controller.abort()
  }, [section, predictionYear, predictionProvince, mapRefreshKey])

  useEffect(() => {
    if (!selectedYear) { setLoadingStats(false); return }
    const controller = new AbortController()
    async function load() {
      setLoadingStats(true)
      setStatsError('')
      try {
        const params = new URLSearchParams({ year: selectedYear })
        if (selectedProvince) params.set('province', selectedProvince)
        const endpoint = selectedProvince ? 'department-map' : 'province-map'
        const response = await fetch(`/api/statistics/${endpoint}?${params}`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail ?? 'No se pudieron cargar las estadísticas territoriales.')
        if (selectedProvince) {
          setDepartmentMetrics(data.departments as TerritoryMetric[])
        } else {
          setProvinceMetrics((data.provinces as Array<Omit<ProvinceMetric, 'name'> & { province: string }>)
            .map((item) => ({ ...item, name: item.province })))
        }
      } catch (reason) {
        if (reason instanceof Error && reason.name === 'AbortError') return
        setStatsError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
      } finally {
        if (!controller.signal.aborted) setLoadingStats(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [selectedYear, selectedProvince, mapRefreshKey])

  useEffect(() => {
    if (!selectedYear) { setStudyYearPoints([]); return }
    const controller = new AbortController()
    async function loadStudyYearDistribution() {
      setStudyYearLoading(true)
      setStudyYearError('')
      try {
        const params = new URLSearchParams({ year: selectedYear, indicator: mapMetric })
        if (selectedProvince) params.set('province', selectedProvince)
        const response = await fetch(`/api/statistics/study-year-distribution?${params}`, { signal: controller.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail ?? 'No se pudo cargar la distribución por año de estudio.')
        setStudyYearPoints(result.study_years as StudyYearPoint[])
      } catch (reason) {
        if (reason instanceof Error && reason.name === 'AbortError') return
        setStudyYearError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
        setStudyYearPoints([])
      } finally {
        if (!controller.signal.aborted) setStudyYearLoading(false)
      }
    }
    void loadStudyYearDistribution()
    return () => controller.abort()
  }, [selectedYear, mapMetric, selectedProvince, mapRefreshKey])

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
  const territoryMetrics = selectedProvince ? departmentMetrics : provinceMetrics
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
        </nav>
        <div className="sidebar-bottom"><span className="status-dot" /> SISTEMA DE DATOS EDUCATIVOS</div>
      </aside>

      <main className="main-area">
        <header className="topbar"><span className="topbar-label">Radar Educativo</span><span className="country-tag">ARGENTINA <span>●</span></span></header>

        {section === 'upload' ? <section className="content upload-content" id="inicio">
          <h1>Importar trayectoria educativa</h1>

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
        </section> : section === 'equality' ? <section className="dashboard">
          <div className="dashboard-title-row equality-title-row">
            <div><h1>Igualdad</h1><p className="intro">Compará las tasas de promoción según sexo y ámbito.</p></div>
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
        </section> : section === 'predictive' ? <section className="dashboard">
          <div className="dashboard-placeholder">
            <h1>Predictivo</h1>
            <p className="intro">Elegí el año que querés proyectar y el alcance. El sistema requiere diez años consecutivos anteriores con datos válidos.</p>
          </div>
          {!years.length && !statsError ? <div className="empty-panel"><span className="empty-icon">✦</span><h2>Todavía no hay datos cargados</h2><p>Subí al menos diez años consecutivos de trayectorias para generar una predicción.</p><button className="secondary-button" onClick={() => navigate('upload')}>Ir a subir archivo →</button></div> : <>
            <div className="prediction-filters">
              <label className="dashboard-year"><span>AÑO A PREDECIR</span><input type="number" min="1900" max="2100" step="1" value={predictionYear} onChange={(event) => setPredictionYear(event.target.value)} aria-label="Año a predecir" /></label>
              <label className="dashboard-year"><span>PROVINCIA</span><select value={predictionProvince} onChange={(event) => setPredictionProvince(event.target.value)}><option>Nación</option>{PROVINCE_NAMES.map((province) => <option key={province}>{province}</option>)}</select></label>
            </div>
            {predictionError && <div className="notice error" role="alert">{predictionError}</div>}
            {predictionLoading ? <div className="loading-panel"><span className="spinner dark" /> Calculando predicción…</div>
              : predictionResult && !predictionResult.eligible ? <div className="empty-panel prediction-empty"><span className="empty-icon">⌛</span><h2>Aún no alcanza el histórico</h2><p>{predictionResult.message}</p><p className="prediction-years">Años válidos consecutivos disponibles: {predictionResult.available_years?.join(', ') || 'ninguno'}</p><button className="secondary-button" onClick={() => navigate('upload')}>Ir a subir archivo →</button></div>
                : predictionResult?.eligible && predictionResult.history && predictionResult.forecast_series && typeof predictionResult.forecast === 'number' && <>
                  <div className="prediction-summary"><div><span>PRONÓSTICO PARA {predictionResult.year}</span><strong>{formatPercent(predictionResult.forecast)}</strong><small>Tasa de no promoción proyectada</small></div><div><span>HISTÓRICO UTILIZADO</span><strong>{predictionResult.history.length} años</strong><small>{predictionResult.history[0]?.year}–{predictionResult.history[predictionResult.history.length - 1]?.year}</small></div><div><span>MODELO</span><strong>Holt</strong><small>Tendencia amortiguada</small></div></div>
                  <article className="prediction-panel"><div className="panel-heading"><div><h3>Histórico y proyección</h3><p>{predictionResult.province} · todos los ámbitos · ambos sexos</p></div><span className="panel-icon">✦</span></div><PredictionChart data={predictionResult.history} year={predictionResult.year} forecasts={predictionResult.forecast_series} /></article>
                  <p className="methodology-note"><strong>Cómo se calcula:</strong> tasa de no promoción = no promovidos / (promovidos + no promovidos) × 100. Se usa Holt con tendencia amortiguada y los parámetros de la notebook (nivel 0,6; tendencia 0,2; amortiguación 0,8). Cuando el histórico incluye 2020–2022, 2021 se reemplaza por el promedio de esos años vecinos; para predicciones anteriores a 2022 se usa solo la información previa, como en la validación temporal.</p>
                </>}
          </>}
        </section> : section === 'reports' ? <section className="dashboard">
          <div className="dashboard-placeholder"><h1>Reportes</h1><p className="intro">Generá informes que integren la información de trayectorias, igualdad y predicciones en un documento.</p><div className="coming-soon"><span className="empty-icon">▤</span><h2>En preparación</h2><p>Esta página se completará en una próxima etapa.</p></div></div>
        </section> : <section className="dashboard">
          <div className="dashboard-title-row">
            <div>{selectedProvince && <button type="button" className="map-back-button" onClick={() => navigate('summary')}>← Todas las provincias</button>}
              <h1>{selectedProvince ?? 'Trayectorias'}</h1>
            </div>
          </div>

          {statsError && <div className="notice error" role="alert">{statsError}</div>}
          {years.length > 0 && <div className="metric-controls-row">
            <div className="metric-switcher" role="group" aria-label="Elegir indicador">
              {MAP_METRICS.map((item) => <button type="button" key={item.id} className={mapMetric === item.id ? 'metric-option active' : 'metric-option'} aria-pressed={mapMetric === item.id} onClick={() => setMapMetric(item.id)}>{item.label}</button>)}
            </div>
            <label className="dashboard-year"><span>AÑO DEL DATASET</span><select value={selectedYear} onChange={(event) => setSelectedYear(event.target.value)}>
              {years.map((item) => <option key={item.year} value={item.year}>{item.year}</option>)}
            </select></label>
          </div>}
          {loadingStats && years.length > 0 ? <div className="loading-panel"><span className="spinner dark" /> Cargando estadísticas…</div>
            : !years.length && !statsError ? <div className="empty-panel"><span className="empty-icon">▤</span><h2>Todavía no hay datos cargados</h2><p>Subí un archivo de trayectoria para empezar a explorar las estadísticas.</p><button className="secondary-button" onClick={() => navigate('upload')}>Ir a subir archivo →</button></div>
              : years.length > 0 && <>
                <div className="metric-heading"><div><h2>{selectedMetric.label}</h2><p>{selectedMetric.description}</p></div><span>TASA</span></div>
                <div className="territory-layout">
                  <article className="map-panel">
                    <div className="panel-heading"><div><h3>{selectedProvince ? 'Por departamento' : 'Por provincia'}</h3><p>{selectedProvince ? 'Compará departamentos de la provincia' : 'Seleccioná una provincia para ver sus departamentos'}</p></div><span className="panel-icon">⌖</span></div>
                    <TerritoryMap
                      data={territoryMetrics}
                      metric={mapMetric}
                      level={selectedProvince ? 'department' : 'province'}
                      province={selectedProvince ?? undefined}
                      onProvinceSelect={selectedProvince ? undefined : navigateProvince}
                    />
                  </article>
                  <article className="province-list-panel">
                    <div className="panel-heading"><div><h3>{selectedProvince ? 'Detalle por departamento' : 'Detalle por provincia'}</h3><p>Ordenado de mayor a menor</p></div><span className="panel-count">{selectedProvince ? departmentMetrics.length : `${provinceMetrics.length}/24`}</span></div>
                    <TerritoryDetailList data={territoryMetrics} metric={mapMetric} level={selectedProvince ? 'department' : 'province'} />
                  </article>
                </div>
                <StudyYearHistogram
                  data={studyYearPoints}
                  metric={mapMetric}
                  territoryName={selectedProvince ?? 'Argentina'}
                  loading={studyYearLoading}
                  error={studyYearError}
                />
                <p className="methodology-note"><strong>Cómo se calcula:</strong> tasa de matrícula = matrícula inicial / población estimada de 4 a 17 años. La población en edad escolar se estima aplicando a la población departamental anual el porcentaje de 4 a 17 años del Censo 2022, que se mantiene constante para todos los años. Promoción = promovidos / (promovidos + no promovidos); no promoción usa la misma base. Para abandono se usa “salidos sin pase” / matrícula inicial como referencia exploratoria: no equivale a la tasa oficial de abandono interanual. Los numeradores provienen de valores absolutos del archivo.</p>
              </>}
        </section>}
      </main>
    </div>
  )
}
