import React from 'react'
import type { Conversation, Workspace } from '@ade/client'

type ChangedFile = { path: string; staged: boolean; unstaged: boolean; conflict: boolean }
type ReviewStatus = { revision: string; files: ChangedFile[] }
type ReviewDiff = { token: string; path: string; staged: boolean; header: string; hunks: string[];
  binary: boolean; conflict: boolean; bytes: number }
type Anchor = { workspace_id: string; path: string; staged: boolean; revision: string;
  token: string; hunk: string; line: number; text: string }
type PendingFeedback = { requestId: string; anchor: Anchor; note: string }
type DiffLine = { key: string; number: number; text: string; selectable: boolean }

function readPending(key: string): PendingFeedback | null {
  const raw = sessionStorage.getItem(key)
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const pending = value as PendingFeedback
    return typeof pending.requestId === 'string' && typeof pending.note === 'string' &&
      pending.anchor && typeof pending.anchor.workspace_id === 'string' ? pending : null
  } catch { return null }
}

function linesInHunk(hunk: string, index: number): DiffLine[] {
  const lines = hunk.split('\n')
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[0] ?? '')
  if (!match) return []
  let next = Number(match[1])
  return lines.slice(1).filter((line, position) => position < lines.length - 2 || line !== '').map((text, position) => {
    const selectable = text.startsWith(' ') || (text.startsWith('+') && !text.startsWith('+++'))
    const number = selectable ? next++ : 0
    return { key: `${index}:${position}`, number, text, selectable }
  })
}

function ReviewDiffView({ diff, status, workspace, selected, onSelect }: {
  diff: ReviewDiff; status: ReviewStatus; workspace: Workspace; selected: Anchor | null; onSelect: (anchor: Anchor) => void
}): React.JSX.Element {
  return <div className="review-diff" aria-label={`Diff for ${diff.path}`}>
    <pre className="review-diff-header">{diff.header}</pre>
    {(diff.binary || diff.conflict || diff.hunks.length === 0) &&
      <p className="muted">This file has no selectable text lines.</p>}
    {diff.hunks.map((hunk, index) => {
      const header = hunk.split('\n')[0]
      return <div className="review-hunk" key={`${header}:${index}`}>
        <div className="review-hunk-heading">{header}</div>
        {linesInHunk(hunk, index).map((line) => line.selectable && !diff.binary && !diff.conflict
          ? <button type="button" className={`review-line ${selected?.hunk === header && selected.line === line.number ? 'selected' : ''}`}
            key={line.key} aria-label={`Select line ${line.number}`} onClick={() => onSelect({
              workspace_id: workspace.id, path: diff.path, staged: diff.staged, revision: status.revision,
              token: diff.token, hunk: header, line: line.number, text: line.text,
            })}><span>{line.number}</span><code>{line.text}</code></button>
          : <div className="review-line" key={line.key}><span /> <code>{line.text}</code></div>)}
      </div>
    })}
  </div>
}

export function ReviewPane({ workspace, conversation, profileKey }: {
  workspace: Workspace; conversation: Conversation | undefined; profileKey: string
}): React.JSX.Element {
  const pendingKey = `ade.reviewPending.${profileKey}.${workspace.id}.${conversation?.id ?? ''}`
  const [restoredPending] = React.useState(() => readPending(pendingKey))
  const [status, setStatus] = React.useState<ReviewStatus | null>(null)
  const [diff, setDiff] = React.useState<ReviewDiff | null>(null)
  const [selected, setSelected] = React.useState<Anchor | null>(restoredPending?.anchor ?? null)
  const [note, setNote] = React.useState(restoredPending?.note ?? '')
  const [error, setError] = React.useState('')
  const [message, setMessage] = React.useState(restoredPending ? 'Feedback delivery is unconfirmed. Retry uses the same request ID.' : '')
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [stale, setStale] = React.useState(false)
  const [pendingId, setPendingId] = React.useState<string | null>(restoredPending?.requestId ?? null)
  const [refresh, setRefresh] = React.useState(0)
  const requestSequence = React.useRef(0)

  React.useEffect(() => {
    if (!restoredPending || !conversation) return
    let disposed = false
    void Promise.all([
      window.adeHost.requestConversation('draft.get', { conversation_id: conversation.id }),
      window.adeHost.requestConversation('conversation.get', { conversation_id: conversation.id }),
    ]).then(([draft, snapshot]) => {
      if (disposed) return
      const pending = draft.send_pending as { request_id?: string } | null
      const messages = Array.isArray(snapshot.messages) ? snapshot.messages as Array<{ id?: string }> : []
      if (!pending && messages.some((item) => item.id === restoredPending.requestId)) {
        sessionStorage.removeItem(pendingKey)
        setPendingId(null)
        setNote('')
        setSelected(null)
        setMessage('Feedback sent to this conversation.')
      } else if (pending && pending.request_id !== restoredPending.requestId) {
        sessionStorage.removeItem(pendingKey)
        setPendingId(null)
        setSelected(null)
        setError('Another prompt is awaiting confirmation in this conversation')
      }
    }).catch(() => { /* Keep the original request ID until the daemon can be queried. */ })
    return () => { disposed = true }
  }, [conversation?.id, pendingKey])

  const rejectFeedback = (detail: string): void => {
    sessionStorage.removeItem(pendingKey)
    setPendingId(null)
    setMessage('')
    setError(detail)
    if (detail.toLowerCase().includes('stale diff')) setStale(true)
  }

  const acceptFeedback = (): void => {
    sessionStorage.removeItem(pendingKey)
    setPendingId(null)
    setNote('')
    setMessage('Feedback sent to this conversation.')
    setError('')
  }

  React.useEffect(() => {
    const sequence = ++requestSequence.current
    setStatus(null)
    setDiff(null)
    if (!pendingId) setSelected(null)
    setStale(false)
    setLoading(true)
    void window.adeHost.requestReview('review.status', { workspace_id: workspace.id }).then((response) => {
      if (sequence !== requestSequence.current) return
      setStatus(response as ReviewStatus)
      setError('')
    }).catch((reason) => { if (sequence === requestSequence.current) setError(String(reason)) })
      .finally(() => { if (sequence === requestSequence.current) setLoading(false) })
    return () => { requestSequence.current++ }
  }, [workspace.id, refresh])

  const chooseFile = async (path: string, staged: boolean): Promise<void> => {
    const sequence = ++requestSequence.current
    setDiff(null)
    if (!pendingId) setSelected(null)
    setStale(false)
    setLoading(true)
    try {
      const response = await window.adeHost.requestReview('review.diff', { workspace_id: workspace.id, path, staged })
      if (sequence === requestSequence.current) { setDiff(response as ReviewDiff); setError('') }
    } catch (reason) { if (sequence === requestSequence.current) setError(String(reason)) }
    finally { if (sequence === requestSequence.current) setLoading(false) }
  }

  const send = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !selected || !conversation || !note.trim() || stale || pendingId) return
    setBusy(true)
    const requestId = globalThis.crypto.randomUUID()
    sessionStorage.setItem(pendingKey, JSON.stringify({ requestId, anchor: selected, note } satisfies PendingFeedback))
    try {
      const response = await window.adeHost.requestConversation('agent.send', {
        conversation_id: conversation.id, request_id: requestId, review_anchor: selected, note,
      })
      if (response.type === 'send_pending') {
        setPendingId(requestId)
        setMessage('Feedback delivery is unconfirmed. Retry uses the same request ID.')
      } else if (response.type === 'review_rejected') {
        rejectFeedback(String(response.message ?? 'Review feedback was not sent'))
      } else {
        acceptFeedback()
      }
    } catch (reason) {
      const detail = String(reason)
      setError(detail)
      setPendingId(requestId)
      setMessage('Feedback delivery is unconfirmed. Retry uses the same request ID.')
    } finally { setBusy(false) }
  }

  const retry = async (): Promise<void> => {
    if (!conversation || !pendingId || busy) return
    setBusy(true)
    try {
      const current = await window.adeHost.requestConversation('conversation.get', { conversation_id: conversation.id })
      const currentMessages = Array.isArray(current.messages) ? current.messages as Array<{ id?: string }> : []
      if (currentMessages.some((item) => item.id === pendingId)) {
        try {
          const confirmed = await window.adeHost.requestConversation('agent.retry_send', {
            conversation_id: conversation.id, request_id: pendingId,
          })
          if (confirmed.type === 'send_pending') return
        } catch (reason) {
          if (!String(reason).includes('No prompt is awaiting confirmation')) throw reason
        }
        acceptFeedback()
        return
      }
      let response: Record<string, unknown>
      try { response = await window.adeHost.requestConversation('agent.retry_send', {
        conversation_id: conversation.id, request_id: pendingId,
      }) }
      catch (reason) {
        if (!String(reason).includes('No prompt is awaiting confirmation')) throw reason
        const snapshot = await window.adeHost.requestConversation('conversation.get', { conversation_id: conversation.id })
        const messages = Array.isArray(snapshot.messages) ? snapshot.messages as Array<{ id?: string }> : []
        if (messages.some((item) => item.id === pendingId)) { acceptFeedback(); return }
        const saved = readPending(pendingKey)
        if (!saved || saved.requestId !== pendingId) throw reason
        response = await window.adeHost.requestConversation('agent.send', {
          conversation_id: conversation.id, request_id: saved.requestId,
          review_anchor: saved.anchor, note: saved.note,
        })
      }
      if (response.type === 'review_rejected') rejectFeedback(String(response.message ?? 'Review feedback was not sent'))
      else if (response.type !== 'send_pending') acceptFeedback()
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  return <section className="review-pane" aria-label="Changes">
    <div className="review-heading"><h2>Changes</h2><button type="button" disabled={loading || busy}
      onClick={() => setRefresh((value) => value + 1)}>Refresh changes</button></div>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {message && <p role="status" className="muted">{message}</p>}
    {loading && <p className="muted">Loading changes…</p>}
    {status?.files.length === 0 && <p className="muted">No changed files in this workspace.</p>}
    {status && <div className="review-files" aria-label="Changed files">{status.files.map((file) =>
      <div className="review-file" key={file.path}><span>{file.path}</span>
        {file.staged && <button type="button" onClick={() => void chooseFile(file.path, true)}>Staged diff</button>}
        {file.unstaged && <button type="button" onClick={() => void chooseFile(file.path, false)}>Unstaged diff</button>}
      </div>)}</div>}
    {diff && status && <ReviewDiffView diff={diff} status={status} workspace={workspace} selected={selected} onSelect={setSelected} />}
    <form className="review-feedback" onSubmit={(event) => void send(event)}>
      <p>{selected ? `${selected.path} · ${selected.staged ? 'staged' : 'unstaged'} · line ${selected.line} · ${selected.token}`
        : 'Select an added or context line to anchor feedback.'}</p>
      <label htmlFor="review-note">Feedback note</label>
      <textarea id="review-note" value={note} rows={3} disabled={Boolean(pendingId)} onChange={(event) => setNote(event.target.value)}
        placeholder="Tell the agent what to change…" />
      <button type="submit" disabled={!selected || !conversation || !note.trim() || busy || stale || Boolean(pendingId)}>
        Send feedback</button>
      {pendingId && <button type="button" disabled={busy} onClick={() => void retry()}>Retry feedback delivery</button>}
      {!conversation && <p className="muted">Create a conversation in this workspace to send feedback.</p>}
    </form>
  </section>
}
