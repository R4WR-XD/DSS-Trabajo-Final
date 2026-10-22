import { FormEvent, useRef, useState } from 'react'

type ImportResult = {
  import_id: number
  file_name: string
  year: number
  rows_processed: number
  message: string
}

export default function App() {
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError('')
    setResult(null)
    const body = new FormData()
    body.append('year', year)
    body.append('file', file)
    try {
      const response = await fetch('/api/imports', { method: 'POST', body })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail ?? 'No se pudo procesar el archivo.')
      setResult(data as ImportResult)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Error de conexión con el servidor.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="DSS Educación, inicio">
          <span className="brand-mark">D</span><span>DSS <b>Educación</b></span>
        </a>
        <span className="topbar-label">Gestión de datos</span>
      </header>

      <section className="content" id="inicio">
        <div className="eyebrow"><span className="eyebrow-dot" /> DATOS EDUCATIVOS · ARGENTINA</div>
        <h1>Importar trayectoria<br /><span>educativa</span></h1>
        <p className="intro">Cargá un dataset anual para procesar y guardar sus observaciones en la base del sistema.</p>

        <form className="upload-card" onSubmit={submit}>
          <div className="card-heading">
            <div><h2>Nueva importación</h2><p>Completá el año y seleccioná el archivo de origen.</p></div>
            <div className="step-number">01 <span>/ 01</span></div>
          </div>

          <label className="field-label" htmlFor="year">Año del dataset</label>
          <div className="year-wrap"><span className="calendar-icon" aria-hidden="true">▦</span>
            <input id="year" type="number" min="1900" max="2100" required value={year}
              onChange={(event) => setYear(event.target.value)} />
            <span className="input-suffix">AÑO</span>
          </div>

          <label className="field-label file-label" htmlFor="dataset">Archivo de datos</label>
          <label className={`dropzone ${file ? 'has-file' : ''}`} htmlFor="dataset">
            <input ref={inputRef} id="dataset" type="file" accept=".csv,.txt,.xlsx,.xls"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            <span className="upload-icon" aria-hidden="true">↑</span>
            <span className="drop-title">{file ? file.name : 'Arrastrá tu archivo o hacé clic para buscar'}</span>
            <span className="drop-meta">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · listo para importar` : 'Formatos admitidos: CSV, TXT, XLSX o XLS'}</span>
          </label>

          {error && <div className="notice error" role="alert">{error}</div>}
          {result && <div className="notice success" role="status">{result.message} Se guardaron {result.rows_processed.toLocaleString('es-AR')} observaciones. Importación #{result.import_id}.</div>}
          <button className="submit-button" type="submit" disabled={!file || busy}>
            {busy ? <><span className="spinner" /> Procesando archivo…</> : <>Procesar e importar <span aria-hidden="true">→</span></>}
          </button>
          <p className="privacy-note"><span aria-hidden="true">⌑</span> Los datos se procesan y almacenan en la base del sistema.</p>
        </form>

        <footer className="page-footer"><span>PLATAFORMA DE SOPORTE A DECISIONES</span><span>EDUCACIÓN · ARGENTINA</span></footer>
      </section>
    </main>
  )
}
