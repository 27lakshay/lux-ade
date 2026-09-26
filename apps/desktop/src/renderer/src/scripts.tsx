import React from 'react'
import type { Workspace } from '@ade/client'

type Script = { name: string }
type Run = { run_id: string; name: string; state: string }
type Output = { available?: boolean; bytes_base64?: string; truncated?: boolean; reason?: string }
type Inspection = Run & { output?: Output; durable_output?: Output }

function decode(output?: Output): string {
  if (!output?.bytes_base64) return ''
  try { return new TextDecoder().decode(Uint8Array.from(atob(output.bytes_base64), (char) => char.charCodeAt(0))) }
  catch { return 'Output could not be decoded' }
}

export function ScriptPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const [scripts, setScripts] = React.useState<Script[]>([])
  const [runs, setRuns] = React.useState<Run[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [inspection, setInspection] = React.useState<Inspection | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const [listed, active] = await Promise.all([
          window.adeHost.requestScript('script.list', { workspace_id: workspace.id }),
          window.adeHost.requestScript('script.runs', { workspace_id: workspace.id }),
        ])
        if (!disposed) {
          setScripts(listed.scripts as Script[])
          setRuns(active.runs as Run[])
          setError('')
        }
      } catch (reason) { if (!disposed) setError(String(reason)) }
      finally { if (!disposed) timer = setTimeout(() => { void load() }, 3000) }
    }
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [workspace.id, refresh])

  React.useEffect(() => {
    if (!selected) { setInspection(null); return }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const current = await window.adeHost.requestScript('script.inspect', {
          workspace_id: workspace.id, run_id: selected, tail_bytes: 4096,
        })
        if (!disposed) { setInspection(current as Inspection); setError('') }
      } catch (reason) { if (!disposed) { setInspection(null); setError(String(reason)) } }
      finally { if (!disposed) timer = setTimeout(() => { void load() }, 2000) }
    }
    setInspection(null)
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [workspace.id, selected, refresh])

  const act = async (op: 'start' | 'stop' | 'retire', value: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.adeHost.requestScript(`script.${op}`, {
        workspace_id: workspace.id,
        ...(op === 'start' ? { name: value } : { run_id: value }),
      })
      if (op === 'start') setSelected(result.run_id as string)
      if (op === 'retire' && selected === value) setSelected(null)
      setError('')
      setRefresh((number) => number + 1)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const selectedRun = runs.find((run) => run.run_id === selected)
  const output = inspection?.durable_output?.available
    ? inspection.durable_output : inspection?.output
  return <section className="service-pane" aria-label="Workspace scripts">
    <div className="service-heading"><h2>Scripts</h2><button type="button" onClick={() => setRefresh((number) => number + 1)}>Refresh</button></div>
    <p className="muted">Run package.json scripts in this workspace. Runs continue when this window closes.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {scripts.length === 0 && !error && <p className="muted">No package scripts found at the workspace root.</p>}
    {scripts.map((script) => <article className="service-row" key={script.name} aria-label={`Script ${script.name}`}>
      <div><strong>{script.name}</strong></div>
      <div className="service-actions"><button type="button" disabled={busy} onClick={() => void act('start', script.name)}>Run</button></div>
    </article>)}
    {runs.length > 0 && <h3>Runs</h3>}
    {runs.map((run) => <article className="service-row" key={run.run_id} aria-label={`Script run ${run.name}`}>
      <div><strong>{run.name}</strong><span className="service-state">{run.state}</span></div>
      <p className="service-ports">{run.run_id}</p>
      <div className="service-actions">
        <button type="button" aria-expanded={selected === run.run_id} onClick={() => setSelected((prior) => prior === run.run_id ? null : run.run_id)}>
          {selected === run.run_id ? 'Hide output' : 'Inspect output'}
        </button>
        <button type="button" disabled={busy || run.state !== 'running'} onClick={() => void act('stop', run.run_id)}>Stop</button>
        <button type="button" disabled={busy || run.state === 'running'} onClick={() => void act('retire', run.run_id)}>Retire</button>
      </div>
      {selectedRun?.run_id === run.run_id && <div className="service-inspection">
        {!inspection ? <p className="muted">Loading script output…</p> : <>
          <p>Execution: {inspection.state}</p>
          <pre>{decode(output) || (output?.available === false ? `Output unavailable: ${output.reason ?? 'unknown reason'}` : 'No output yet')}</pre>
          {output?.truncated && <p>Earlier output is outside the retained tail.</p>}
        </>}
      </div>}
    </article>)}
  </section>
}
