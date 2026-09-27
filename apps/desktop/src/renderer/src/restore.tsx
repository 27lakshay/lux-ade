import React from 'react'
import type { RestoreBindings, RestoreEntry, RestoreKind } from './types'

export function RestoreBindingsPanel({ bootId, profileKey, onWorkspaceBindings }: {
  bootId: string | null; profileKey: string; onWorkspaceBindings: (ids: string[]) => void
}): React.JSX.Element | null {
  const [bindings, setBindings] = React.useState<RestoreBindings | null>(null)
  const [targetPath, setTargetPath] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [revision, setRevision] = React.useState(0)
  React.useEffect(() => {
    const timer = window.setInterval(() => setRevision((value) => value + 1), 5_000)
    return () => window.clearInterval(timer)
  }, [bootId])
  React.useEffect(() => {
    let active = true
    setLoading(true)
    void window.adeHost.listRestoreBindings().then((next) => {
      if (active) {
        setBindings(next)
        onWorkspaceBindings(next.workspaces.filter((item) => item.needs_rebind).map((item) => item.id))
        setError('')
      }
    }).catch((reason) => { if (active) setError(`Recovery status could not be loaded: ${String(reason)}`) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bootId, revision])
  const pending: Array<{ kind: RestoreKind; entry: RestoreEntry; label: string }> = bindings ? [
    ...bindings.lifecycle.filter((entry) => entry.needs_rebind).map((entry) =>
      ({ kind: 'worktree' as const, entry, label: 'Worktree repository' })),
    ...bindings.repositories.filter((entry) => entry.needs_rebind).map((entry) =>
      ({ kind: 'repository' as const, entry, label: 'Git repository' })),
    ...bindings.workspaces.filter((entry) => entry.needs_rebind).map((entry) =>
      ({ kind: 'workspace' as const, entry, label: entry.name })),
  ] : []
  const next = pending[0]
  if (!next && !error) return null
  const bind = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!next || !targetPath.trim() || busy || loading) return
    setBusy(true)
    setError('')
    try {
      await window.adeHost.rebindRestored(profileKey, next.kind, next.entry.id, targetPath.trim())
      setTargetPath('')
      setRevision((value) => value + 1)
    } catch (reason) { setError(`Could not bind ${next.label}: ${String(reason)}`) }
    finally { setBusy(false) }
  }
  const choose = async (): Promise<void> => {
    if (busy || loading) return
    try {
      const selected = await window.adeHost.chooseRestoreFolder()
      if (selected) setTargetPath(selected)
    } catch (reason) { setError(`Could not choose a folder: ${String(reason)}`) }
  }
  return <section className="restore-bindings" aria-label="Restore workspace paths">
    <h2>Restore workspace paths</h2>
    {loading && <p role="status">Checking saved paths…</p>}
    {next && !loading && <>
      <p className="restore-progress" role="status">{pending.length} path{pending.length === 1 ? '' : 's'} remaining · Next: {next.label}</p>
      <p className="workspace-root" title={next.entry.root}>Saved path: {next.entry.root}</p>
      {next.entry.rebindable === false ? <p role="alert" className="inline-error">This backup lacks the saved physical identity needed to verify a replacement. Restore a newer backup to recover this path safely.</p> : <>
      <p className="muted">Choose a different folder for each saved resource. ADE keeps its history and verifies the selected directory before work resumes.</p>
      <form onSubmit={(event) => void bind(event)}>
        <label className="field-label" htmlFor="restore-target">Replacement folder</label>
        <input id="restore-target" value={targetPath} onChange={(event) => setTargetPath(event.target.value)}
          placeholder="/path/to/new-checkout" disabled={busy} />
        <div className="restore-actions">
          <button type="button" disabled={busy} onClick={() => void choose()}>Browse…</button>
          <button type="submit" disabled={busy || !targetPath.trim()}>{busy ? 'Checking…' : 'Bind folder'}</button>
        </div>
      </form>
      </>}
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {!busy && !loading && <button type="button" className="restore-refresh" onClick={() => setRevision((value) => value + 1)}>Refresh paths</button>}
  </section>
}
