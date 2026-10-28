import { FormEvent, useEffect, useRef, useState } from 'react'

type ImportResult = {
  import_id: number
  file_name: string
  year: number
  rows_processed: number
  message: string
}
type AvailableYear = { year: number; import_id: number; file_name: string }
type ChartPoint = { label: string; value: number }
type Statistics = {
  year: number
  import_id: number
  file_name: string
  summary: {
    observations: number
    provinces: number
    departments: number
    promoted: number
    not_promoted: number
    graduates: number
  }
  available_indicators: string[]
  by_province: ChartPoint[]
  by_study_year: ChartPoint[]
}

const INDICATOR_LABELS: Record<string, string> = {
  promovidos: 'Promovidos', nopromo: 'No promovidos', regulares: 'Alumnos regulares',
  entrados: 'Entrados', inicial: 'Nivel inicial', scp: 'Sobreedad con promoción',
  ssp: 'Sobreedad sin promoción', ultimo: 'Último año', otros: 'Otros',
  primaria_egresados: 'Egresados de primaria', secundaria_egresados: 'Egresados de secundaria',
}
const formatNumber = (value: number) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(value)

function Chart({ title, subtitle, data, kind }: { title: string; subtitle: string; data: ChartPoint[]; kind: 'province' | 'study' }) {
  const points = kind === 'province' ? data.slice(0, 10) : [...data].sort((a, b) => {
    const an = Number(a.label), bn = Number(b.label)
    return Number.isNaN(an) || Number.isNaN(bn) ? a.label.localeCompare(b.label) : an - bn
  })
  const maximum = Math.max(...points.map((point) => point.value), 1)
  return (
    <article className="chart-card">
      <div className="chart-heading"><div><h3>{title}</h3><p>{subtitle}</p></div><span className="chart-menu" aria-hidden="true">···</span></div>
      {points.length ? <div className={`bar-chart ${kind}`}>
        {points.map((point) => <div className="bar-row" key={point.label}>
          <span className="bar-label" title={point.label}>{point.label}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(point.value / maximum * 100, 1.5)}%` }} /></div>
          <span className="bar-value">{formatNumber(point.value)}</span>
        </div>)}
      </div> : <div className="chart-empty">No hay datos para este indicador.</div>}
    </article>
  )
}

export default function App() {
  const [section, setSection] = useState<'statistics' | 'upload'>('statistics')
  const [uploadYear, setUploadYear] = useState(String(new Date().getFullYear()))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [years, setYears] = useState<AvailableYear[]>([])
  const [selectedYear, setSelectedYear] = useState('')
  const [indicator, setIndicator] = useState('promovidos')
  const [statistics, setStatistics] = useState<Statistics | null>(null)
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
      } else {
        setSelectedYear('')
        setStatistics(null)
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
        const params = new URLSearchParams({ year: selectedYear, indicator })
        const response = await fetch(`/api/statistics?${params}`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail ?? 'No se pudieron cargar las estadísticas.')
        setStatistics(data as Statistics)
      } catch (reason) {
        if (reason instanceof Error && reason.name === 'AbortError') return
        setStatsError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
      } finally {
        if (!controller.signal.aborted) setLoadingStats(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [selectedYear, indicator])

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
      await refreshYears(Number(uploadYear))
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
    } finally {
      setBusy(false)
    }
  }

  const summary = statistics?.summary
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <a className="brand" href="#inicio" aria-label="Gestión de Trayectorias Educativas, inicio">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" focusable="false">
              <path d="M4 12.5 16 6l12 6.5L16 19 4 12.5Z" />
              <path d="M9 15.5V21c4.2 3.1 9.8 3.1 14 0v-5.5" />
              <path d="M27 13v7" />
              <circle cx="27" cy="22" r="1.5" />
            </svg>
          </span><span>Gestión de <b>Trayectorias Educativas</b></span>
        </a>
        <div className="sidebar-caption">MENÚ PRINCIPAL</div>
        <nav className="side-nav" aria-label="Navegación principal">
          <button className={section === 'statistics' ? 'nav-item active' : 'nav-item'} onClick={() => setSection('statistics')}>
            <span className="nav-icon">▥</span> Estadísticas
          </button>
          <button className={section === 'upload' ? 'nav-item active' : 'nav-item'} onClick={() => setSection('upload')}>
            <span className="nav-icon">↑</span> Subir archivo
          </button>
        </nav>
        <div className="sidebar-bottom"><span className="status-dot" /> SISTEMA DE DATOS EDUCATIVOS</div>
      </aside>

      <main className="main-area">
        <header className="topbar"><span className="topbar-label">Gestión de Trayectorias Educativas</span><span className="country-tag">ARGENTINA <span>●</span></span></header>

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
        </section> : <section className="dashboard">
          <div className="dashboard-title-row">
            <div><div className="eyebrow"><span className="eyebrow-dot" /> PANEL DE ANÁLISIS</div><h1>Estadísticas</h1><p className="intro">Explorá los principales datos de trayectoria educativa.</p></div>
            <label className="dashboard-year"><span>AÑO DEL DATASET</span><select value={selectedYear} onChange={(event) => setSelectedYear(event.target.value)} disabled={!years.length}>
              {years.length ? years.map((item) => <option key={item.year} value={item.year}>{item.year}</option>) : <option value="">Sin datos</option>}
            </select></label>
          </div>

          {statsError && <div className="notice error" role="alert">{statsError}</div>}
          {loadingStats && years.length > 0 ? <div className="loading-panel"><span className="spinner dark" /> Cargando estadísticas…</div>
            : !years.length && !statsError ? <div className="empty-panel"><span className="empty-icon">▤</span><h2>Todavía no hay datos cargados</h2><p>Subí un archivo de trayectoria para empezar a explorar las estadísticas.</p><button className="secondary-button" onClick={() => setSection('upload')}>Ir a subir archivo →</button></div>
              : statistics && <>
                <div className="data-source"><span>Última importación del año</span><b>{statistics.file_name}</b><span>· {formatNumber(summary?.observations ?? 0)} observaciones</span></div>
                <div className="stats-grid">
                  <article className="stat-card"><div className="stat-top"><span>OBSERVACIONES</span><span className="stat-icon green">▤</span></div><strong>{formatNumber(summary?.observations ?? 0)}</strong><small>Registros procesados</small><div className="stat-accent" /></article>
                  <article className="stat-card"><div className="stat-top"><span>PROVINCIAS</span><span className="stat-icon blue">⌖</span></div><strong>{formatNumber(summary?.provinces ?? 0)}</strong><small>Con datos disponibles</small><div className="stat-accent blue-accent" /></article>
                  <article className="stat-card"><div className="stat-top"><span>DEPARTAMENTOS</span><span className="stat-icon amber">▦</span></div><strong>{formatNumber(summary?.departments ?? 0)}</strong><small>Con datos disponibles</small><div className="stat-accent amber-accent" /></article>
                  <article className="stat-card"><div className="stat-top"><span>PROMOVIDOS</span><span className="stat-icon violet">↗</span></div><strong>{formatNumber(summary?.promoted ?? 0)}</strong><small>Total informado · sexo total</small><div className="stat-accent violet-accent" /></article>
                </div>

                <div className="visualizations-heading"><div><h2>Visualizaciones</h2><p>Compará la distribución territorial y por año de estudio.</p></div>
                  <label className="indicator-select"><span>INDICADOR</span><select value={indicator} onChange={(event) => setIndicator(event.target.value)}>
                    {Array.from(new Set(['promovidos', ...(statistics.available_indicators ?? [])])).map((item) => <option value={item} key={item}>{INDICATOR_LABELS[item] ?? item.split('_').join(' ')}</option>)}
                  </select></label>
                </div>
                <div className="charts-grid">
                  <Chart title="Distribución por provincia" subtitle={`${INDICATOR_LABELS[indicator] ?? indicator} · principales 10`} data={statistics.by_province} kind="province" />
                  <Chart title="Por año de estudio" subtitle={`${INDICATOR_LABELS[indicator] ?? indicator} · sexo total`} data={statistics.by_study_year} kind="study" />
                </div>
                <p className="data-note">Los valores muestran la suma de la última importación para el año seleccionado. Las visualizaciones usan registros de sexo total.</p>
              </>}
        </section>}
      </main>
    </div>
  )
}
