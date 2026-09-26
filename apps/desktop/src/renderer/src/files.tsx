import React from 'react'
import type { Workspace } from '@ade/client'

type Entry = { name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other'; size: number | null }
type Page = { entries?: Entry[]; results?: Entry[]; next_cursor: string | null; incomplete: boolean }
type Preview = { path: string; kind: 'text' | 'image' | 'unsupported'; mime?: string; text?: string;
  bytes_base64?: string; size: number; truncated: boolean }
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'])

function entriesFrom(value: Record<string, unknown>, search: boolean): Page {
  const rows = search ? value.results : value.entries
  if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === 'object' &&
    typeof row.name === 'string' && typeof row.path === 'string' &&
    ['directory', 'file', 'symlink', 'other'].includes(row.kind))) throw new Error('Invalid file listing')
  if (value.next_cursor !== null && typeof value.next_cursor !== 'string') throw new Error('Invalid file cursor')
  return { entries: search ? undefined : rows as Entry[], results: search ? rows as Entry[] : undefined,
    next_cursor: value.next_cursor as string | null, incomplete: value.incomplete === true }
}

function parent(path: string): string { return path.split('/').slice(0, -1).join('/') }
function sizeLabel(size: number | null): string { return size === null ? '' : `${size.toLocaleString()} B` }

export function FilesPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const [path, setPath] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [rows, setRows] = React.useState<Entry[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [incomplete, setIncomplete] = React.useState(false)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [previewBusy, setPreviewBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [previewError, setPreviewError] = React.useState('')
  const [blockedEntry, setBlockedEntry] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  const pageRequest = React.useRef(0)
  const previewRequest = React.useRef(0)

  React.useEffect(() => {
    const token = ++pageRequest.current
    setRows([]); setCursor(null); setIncomplete(false); setBusy(true); setError('')
    const op = search ? 'file.search' : 'file.list'
    const fields = search ? { workspace_id: workspace.id, query: search, limit: 100 } :
      { workspace_id: workspace.id, path, limit: 100 }
    void window.adeHost.requestFile(op, fields).then((result) => {
      if (token !== pageRequest.current) return
      const page = entriesFrom(result, Boolean(search))
      setRows(page.results ?? page.entries ?? []); setCursor(page.next_cursor); setIncomplete(page.incomplete)
    }).catch((reason) => { if (token === pageRequest.current) setError(String(reason)) })
      .finally(() => { if (token === pageRequest.current) setBusy(false) })
    return () => { pageRequest.current++ }
  }, [workspace.id, path, search, refresh])

  React.useEffect(() => {
    const token = ++previewRequest.current
    setPreview(null); setPreviewError('')
    if (!selected) { setPreviewBusy(false); return () => { previewRequest.current++ } }
    setPreviewBusy(true)
    void window.adeHost.requestFile('file.preview', { workspace_id: workspace.id, path: selected }).then((result) => {
      if (token !== previewRequest.current) return
      if (result.path !== selected || !['text', 'image', 'unsupported'].includes(String(result.kind))) {
        throw new Error('Invalid file preview')
      }
      setPreview(result as Preview)
    }).catch((reason) => { if (token === previewRequest.current) setPreviewError(String(reason)) })
      .finally(() => { if (token === previewRequest.current) setPreviewBusy(false) })
    return () => { previewRequest.current++ }
  }, [workspace.id, selected, refresh])

  const more = async (): Promise<void> => {
    if (!cursor || busy) return
    const token = ++pageRequest.current
    const next = cursor
    setBusy(true); setError('')
    try {
      const result = await window.adeHost.requestFile(search ? 'file.search' : 'file.list', search ?
        { workspace_id: workspace.id, query: search, cursor: next, limit: 100 } :
        { workspace_id: workspace.id, path, cursor: next, limit: 100 })
      if (token !== pageRequest.current) return
      const page = entriesFrom(result, Boolean(search))
      setRows((current) => [...current, ...(page.results ?? page.entries ?? [])]); setCursor(page.next_cursor)
      setIncomplete((current) => current || page.incomplete)
    } catch (reason) { if (token === pageRequest.current) setError(String(reason)) }
    finally { if (token === pageRequest.current) setBusy(false) }
  }
  const open = (entry: Entry): void => {
    if (entry.kind === 'directory') { setPath(entry.path); setSearch(''); setQuery(''); setSelected(null); setBlockedEntry('') }
    else if (entry.kind === 'file') { setSelected(entry.path); setBlockedEntry('') }
    else { setSelected(null); setBlockedEntry(`${entry.name} is a ${entry.kind}; it cannot be previewed.`) }
  }
  const imageUrl = preview?.kind === 'image' && preview.mime && imageTypes.has(preview.mime) &&
    preview.bytes_base64 && preview.bytes_base64.length <= 700_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(preview.bytes_base64) ?
    `data:${preview.mime};base64,${preview.bytes_base64}` : null

  return <section className="files-pane" aria-label="Workspace files">
    <div className="files-heading"><h2>Files</h2><button type="button" onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div>
    <form className="files-search" role="search" onSubmit={(event) => {
      event.preventDefault(); setSearch(query.trim()); setSelected(null); setBlockedEntry('')
    }}>
      <label htmlFor="file-search">Search file names</label>
      <input id="file-search" value={query} maxLength={256} onChange={(event) => setQuery(event.target.value)} placeholder="Find files" />
      <button type="submit" disabled={!query.trim()}>Search</button>
      {search && <button type="button" onClick={() => { setSearch(''); setQuery(''); setSelected(null); setBlockedEntry('') }}>Clear</button>}
    </form>
    <div className="files-location">
      {search ? <span>Results for “{search}”</span> : <><button type="button" disabled={!path} onClick={() => { setPath(parent(path)); setSelected(null); setBlockedEntry('') }}>Up</button>
        <span title={path}>{path || 'Workspace root'}</span></>}
    </div>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {incomplete && <p role="status" className="inline-error">{search
      ? 'Search reached its directory or depth limit. Inspect a smaller folder directly.'
      : 'This folder exceeds the listing limit. Search by name or inspect a smaller folder.'}</p>}
    <div className="files-layout">
      <div className="files-list" aria-label={search ? 'Matching files' : 'Folder contents'}>
        {rows.map((entry) => <button type="button" key={`${entry.kind}:${entry.path}`} className={selected === entry.path ? 'selected' : ''}
          onClick={() => open(entry)} aria-label={`${entry.kind} ${entry.path}`}>
          <span className="files-kind" aria-hidden="true">{entry.kind === 'directory' ? '▸' : entry.kind === 'file' ? '·' : '↗'}</span>
          <span className="files-name">{search ? entry.path : entry.name}</span><span className="files-size">{sizeLabel(entry.size)}</span>
        </button>)}
        {busy && <p role="status">Loading files…</p>}
        {!busy && rows.length === 0 && !error && !incomplete && <p>{cursor && search
          ? 'No matches in this portion yet. Continue searching.' : search ? 'No matching files.' : 'No files here.'}</p>}
        {cursor && <button type="button" className="files-more" disabled={busy} onClick={() => void more()}>
          {search ? 'Continue search' : 'Load more'}</button>}
      </div>
      <div className="files-preview" aria-label="File preview">
        {previewBusy && <p role="status">Loading preview…</p>}
        {blockedEntry && <p role="status">{blockedEntry}</p>}
        {previewError && <p role="alert" className="inline-error">{previewError}</p>}
        {!selected && !previewError && !blockedEntry && <p>Choose a file to preview.</p>}
        {preview && <><h3>{preview.path}</h3><p>{sizeLabel(preview.size)}{preview.truncated ? ' · Preview truncated' : ''}</p>
          {preview.kind === 'text' && typeof preview.text === 'string' && <pre>{preview.text}</pre>}
          {imageUrl && <img src={imageUrl} alt={`Preview of ${preview.path}`} />}
          {(preview.kind === 'unsupported' || (preview.kind === 'image' && !imageUrl)) && <p>Preview unavailable for this file format or size.</p>}
        </>}
      </div>
    </div>
  </section>
}
