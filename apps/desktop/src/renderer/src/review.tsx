import React from 'react'
import type { Conversation, Workspace } from '@ade/client'

type ChangedFile = { path: string; staged: boolean; unstaged: boolean; conflict: boolean;
  untracked: boolean; submodule: boolean }
type ReviewStatus = { revision: string; index_token: string; conflicts: number; files: ChangedFile[] }
type ReviewDiff = { token: string; path: string; staged: boolean; header: string; hunks: string[];
  binary: boolean; conflict: boolean; bytes: number }
type Anchor = { workspace_id: string; path: string; staged: boolean; revision: string;
  token: string; hunk: string; line: number; text: string }
type PendingFeedback = { requestId: string; anchor: Anchor; note: string }
type GitMutation = 'review.stage' | 'review.unstage' | 'review.commit' | 'review.discard'
type PendingGit = { op: GitMutation; request_id: string; workspace_id: string; path?: string;
  revision?: string; diff_token?: string; index_token?: string; message?: string }
type DiscardPreview = { path: string; revision: string; diff_token: string }
type AcknowledgedGit = { intent: PendingGit; acknowledged_at: number }
type GitReceipt = { type: 'review_operation'; operation: { id: string; status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  error?: string; backup_path?: string; result?: { head?: string } } }
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
  return <div className="review-diff" role="region" aria-label={`Diff for ${diff.path}`}>
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
  const [acknowledgedGit, setAcknowledgedGit] = React.useState<AcknowledgedGit[]>([])
  const [status, setStatus] = React.useState<ReviewStatus | null>(null)
  const [diff, setDiff] = React.useState<ReviewDiff | null>(null)
  const [discardPreview, setDiscardPreview] = React.useState<DiscardPreview | null>(null)
  const [selected, setSelected] = React.useState<Anchor | null>(restoredPending?.anchor ?? null)
  const [note, setNote] = React.useState(restoredPending?.note ?? '')
  const [error, setError] = React.useState('')
  const [message, setMessage] = React.useState(restoredPending ? 'Feedback delivery is unconfirmed. Retry uses the same request ID.' : '')
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [stale, setStale] = React.useState(false)
  const [pendingId, setPendingId] = React.useState<string | null>(restoredPending?.requestId ?? null)
  const [pendingGit, setPendingGit] = React.useState<PendingGit | null>(null)
  const [gitReady, setGitReady] = React.useState(false)
  const [gitUnknown, setGitUnknown] = React.useState(false)
  const [gitInterrupted, setGitInterrupted] = React.useState(false)
  const [gitMessage, setGitMessage] = React.useState('')
  const [gitBusy, setGitBusy] = React.useState(false)
  const [commitMessage, setCommitMessage] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  const requestSequence = React.useRef(0)
  const gitStarting = React.useRef(false)

  React.useEffect(() => {
    let disposed = false
    void window.adeHost.readGitJournal(workspace.id).then((result) => {
      if (disposed) return
      const pending = result.pending as PendingGit | null
      setPendingGit(pending)
      setAcknowledgedGit(result.archived as AcknowledgedGit[])
      setGitMessage(pending ? `Checking prior Git operation ${pending.request_id}` : '')
      setGitReady(true)
    }).catch((reason) => { if (!disposed) setGitMessage(`Git recovery unavailable: ${String(reason)}`) })
    return () => { disposed = true }
  }, [workspace.id])

  React.useEffect(() => {
    if (!pendingGit || gitUnknown || gitInterrupted || gitBusy) return
    let disposed = false
    let polling = false
    const check = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const response = await window.adeHost.requestReview('review.operation', {
          workspace_id: workspace.id, request_id: pendingGit.request_id,
        }) as GitReceipt
        if (disposed) return
        if (response.type !== 'review_operation' || response.operation?.id !== pendingGit.request_id) {
          throw new Error('Git operation receipt did not match the request')
        }
        const operation = response.operation
        const retained = pendingGit.op === 'review.discard' && operation.backup_path
          ? ` · Recovery file: ${operation.backup_path}` : ''
        if (operation.status === 'running') {
          setGitMessage(`${pendingGit.op.slice(7)} is running · ${pendingGit.request_id}`)
        } else if (operation.status === 'interrupted') {
          setGitInterrupted(true)
          setGitMessage(`Git operation ${pendingGit.request_id} was interrupted. Inspect Git history and changes before continuing. It will not be retried automatically.${retained}`)
        } else {
          await window.adeHost.acknowledgeGitJournal(workspace.id, pendingGit.request_id, 'settle')
          if (disposed) return
          setPendingGit(null)
          setGitUnknown(false)
          setGitMessage(operation.status === 'succeeded'
            ? `${pendingGit.op.slice(7)} succeeded${operation.result?.head ? ` · ${operation.result.head}` : ''}${retained}`
            : `${pendingGit.op.slice(7)} failed: ${operation.error ?? 'Inspect Git state before continuing'}${retained}`)
          if (pendingGit.op === 'review.commit' && operation.status === 'succeeded') setCommitMessage('')
          setRefresh((value) => value + 1)
        }
      } catch (reason) {
        if (disposed) return
        const detail = String(reason)
        if (detail.includes('Unknown review operation')) {
          setGitUnknown(true)
          setGitMessage(`Git operation ${pendingGit.request_id} was not found. You can retry the original request ID and parameters.`)
        } else setGitMessage(`Git operation ${pendingGit.request_id} is unconfirmed: ${detail}`)
      } finally { polling = false }
    }
    void check()
    const timer = window.setInterval(() => void check(), 750)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [pendingGit, gitUnknown, gitInterrupted, gitBusy, workspace.id])

  const startGit = async (request: Omit<PendingGit, 'request_id' | 'workspace_id'>): Promise<void> => {
    if (gitStarting.current || pendingGit || !status || !gitReady) return
    gitStarting.current = true
    const pending: PendingGit = { ...request, workspace_id: workspace.id, request_id: globalThis.crypto.randomUUID() }
    try {
      setPendingGit(pending)
      setGitUnknown(false)
      setGitInterrupted(false)
      setGitMessage(`Submitting ${pending.op.slice(7)} · ${pending.request_id}`)
      setGitBusy(true)
      await window.adeHost.requestReview(pending.op, pending)
    } catch (reason) {
      setGitMessage(`Git operation ${pending.request_id} is unconfirmed: ${String(reason)}. Check its receipt before another action.`)
      try {
        const recorded = await window.adeHost.readGitJournal(workspace.id)
        const active = recorded.pending as PendingGit | null
        if (!active) { setPendingGit(null); setGitMessage(`Git operation was rejected before admission: ${String(reason)}`) }
        else if (active.request_id !== pending.request_id) {
          setPendingGit(active)
          setGitMessage(`A prior Git operation ${active.request_id} owns this workspace. Its receipt is being checked.`)
        }
      } catch { /* Preserve the ID until recovery storage can be read. */ }
    } finally { setGitBusy(false); gitStarting.current = false }
  }

  const retryGit = async (): Promise<void> => {
    if (!pendingGit || !gitUnknown || gitBusy) return
    setGitBusy(true)
    setGitUnknown(false)
    setGitMessage(`Retrying original Git operation ${pendingGit.request_id}`)
    try { await window.adeHost.requestReview(pendingGit.op, pendingGit) }
    catch (reason) { setGitMessage(`Git operation ${pendingGit.request_id} remains unconfirmed: ${String(reason)}`) }
    finally { setGitBusy(false) }
  }

  const checkGit = (): void => { setGitUnknown(false); setGitInterrupted(false) }

  const acknowledgeInterruptedGit = async (): Promise<void> => {
    if (!pendingGit || !gitInterrupted) return
    try {
      await window.adeHost.acknowledgeGitJournal(workspace.id, pendingGit.request_id, 'interrupted')
      const recorded = await window.adeHost.readGitJournal(workspace.id)
      setAcknowledgedGit(recorded.archived as AcknowledgedGit[])
    } catch (reason) { setGitMessage(`Could not retain Git operation ${pendingGit.request_id}: ${String(reason)}`); return }
    setPendingGit(null)
    setGitInterrupted(false)
    setGitMessage('Interrupted Git operation retained below. Refresh changes before the next action.')
    setRefresh((value) => value + 1)
  }

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
    setDiscardPreview(null)
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
    setDiscardPreview(null)
    if (!pendingId) setSelected(null)
    setStale(false)
    setLoading(true)
    try {
      const response = await window.adeHost.requestReview('review.diff', { workspace_id: workspace.id, path, staged })
      if (sequence === requestSequence.current) { setDiff(response as ReviewDiff); setError('') }
    } catch (reason) { if (sequence === requestSequence.current) setError(String(reason)) }
    finally { if (sequence === requestSequence.current) setLoading(false) }
  }

  const previewDiscard = async (path: string): Promise<void> => {
    const sequence = ++requestSequence.current
    setDiscardPreview(null)
    setDiff(null)
    setLoading(true)
    try {
      const latest = await window.adeHost.requestReview('review.status', { workspace_id: workspace.id, force: true }) as ReviewStatus
      const file = latest.files.find((item) => item.path === path)
      if (!file?.unstaged || file.untracked || file.conflict || file.submodule) {
        throw new Error('This file cannot be discarded; refresh changes')
      }
      const preview = await window.adeHost.requestReview('review.diff', {
        workspace_id: workspace.id, path, staged: false,
      }) as ReviewDiff
      if (sequence !== requestSequence.current) return
      setStatus(latest)
      setDiff(preview)
      setDiscardPreview({ path, revision: latest.revision, diff_token: preview.token })
      setError('')
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
    {gitMessage && <p role={gitInterrupted ? 'alert' : 'status'} className={gitInterrupted ? 'inline-error' : 'muted'}>{gitMessage}</p>}
    {pendingGit && <div className="review-operation">
      <span>Git operation: {pendingGit.op.slice(7)} · {pendingGit.request_id}</span>
      {(gitUnknown || gitInterrupted) && <button type="button" disabled={gitBusy} onClick={checkGit}>Check Git operation</button>}
      {gitUnknown && <button type="button" disabled={gitBusy} onClick={() => void retryGit()}>Retry Git operation</button>}
      {gitInterrupted && <button type="button" onClick={() => void acknowledgeInterruptedGit()}>Acknowledge after inspecting Git</button>}
    </div>}
    {acknowledgedGit.length > 0 && <div className="review-operation-history" aria-label="Interrupted Git operations">
      <strong>Interrupted Git operations</strong>
      {acknowledgedGit.map(({ intent }) => <p key={intent.request_id}>
        {intent.op.slice(7)} · {intent.request_id}{intent.path ? ` · ${intent.path}` : ''}
      </p>)}
    </div>}
    {loading && <p className="muted">Loading changes…</p>}
    {status?.files.length === 0 && <p className="muted">No changed files in this workspace.</p>}
    {status && <div className="review-files" aria-label="Changed files">{status.files.map((file) =>
      <div className="review-file" key={file.path}><span>{file.path}</span>
        {file.conflict && <strong>Conflict</strong>}
        {file.unstaged && !file.conflict && <button type="button" disabled={!gitReady || Boolean(pendingGit) || loading}
          onClick={() => void startGit({ op: 'review.stage', path: file.path, revision: status.revision })}
          aria-label={`Stage ${file.path}`}>Stage</button>}
        {file.staged && <button type="button" disabled={!gitReady || Boolean(pendingGit) || loading}
          onClick={() => void startGit({ op: 'review.unstage', path: file.path, revision: status.revision })}
          aria-label={`Unstage ${file.path}`}>Unstage</button>}
        {file.unstaged && !file.untracked && !file.conflict && !file.submodule &&
          <button type="button" disabled={!gitReady || Boolean(pendingGit) || loading}
            onClick={() => void previewDiscard(file.path)} aria-label={`Preview discard ${file.path}`}>
            Discard…</button>}
        {file.staged && <button type="button" onClick={() => void chooseFile(file.path, true)}>Staged diff</button>}
        {file.unstaged && <button type="button" onClick={() => void chooseFile(file.path, false)}>Unstaged diff</button>}
      </div>)}</div>}
    {status && <form className="review-commit" onSubmit={(event) => {
      event.preventDefault()
      if (!commitMessage.trim() || !status.files.some((file) => file.staged) || status.conflicts || pendingGit) return
      void startGit({ op: 'review.commit', index_token: status.index_token, message: commitMessage })
    }}>
      <label htmlFor="review-commit-message">Commit message</label>
      <textarea id="review-commit-message" value={commitMessage} rows={3} maxLength={65_536}
        disabled={Boolean(pendingGit)} onChange={(event) => setCommitMessage(event.target.value)} />
      <button type="submit" disabled={!commitMessage.trim() || !status.files.some((file) => file.staged) ||
        status.conflicts > 0 || Boolean(pendingGit) || !gitReady || loading}>Commit staged changes</button>
      {status.conflicts > 0 && <p className="muted">Resolve and stage conflicts before committing.</p>}
    </form>}
    {diff && status && <ReviewDiffView diff={diff} status={status} workspace={workspace} selected={selected} onSelect={setSelected} />}
    {discardPreview && diff?.path === discardPreview.path && !diff.staged &&
      <div className="review-discard-confirm" role="group" aria-label={`Discard ${discardPreview.path}`}>
        <p>{diff.binary
          ? `Binary contents of ${discardPreview.path} cannot be previewed. Discard replaces its working-tree bytes with the staged version.`
          : diff.hunks.length === 0
            ? `No text lines are available for ${discardPreview.path}; review the Git metadata above before discarding.`
            : `Discard the working-tree changes shown above for ${discardPreview.path}?`}
          {' '}Staged changes stay staged.</p>
        <button type="button" disabled={Boolean(pendingGit) || !gitReady || loading}
          onClick={() => void startGit({ op: 'review.discard', path: discardPreview.path,
            revision: discardPreview.revision, diff_token: discardPreview.diff_token })}>
          Confirm discard</button>
        <button type="button" onClick={() => setDiscardPreview(null)}>Cancel</button>
      </div>}
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
