import React from 'react'
import type { Conversation } from '@ade/client'
import { startConversationProjection } from '@ade/client/sync'
import type { Message, PendingRequest, Snapshot } from './types'

function contentSummary(message: Message): string {
  if (message.text) return message.text
  const content = message.content
  if (!content) return `${message.kind} record`
  if (content.type === 'plan') return `Plan: ${String(content.explanation ?? 'Updated')}`
  if (content.type === 'tool') return `${String(content.command ?? content.name ?? 'Tool')} · ${message.status}`
  if (content.type === 'subagents') return `Subagents · ${message.status}`
  return `${String(content.type ?? message.kind)} record · ${JSON.stringify(content)}`
}

function requestSummary(request: PendingRequest): string {
  const params = request.params
  if (typeof params.command === 'string') return `Run ${params.command}`
  if (Array.isArray(params.questions)) return params.questions.map((item) =>
    typeof item === 'object' && item && 'question' in item ? String(item.question) : 'Question').join(' · ')
  return request.method
}

type Question = { id: string; question: string; options?: Array<{ label: string }>; multiSelect?: boolean; isSecret?: boolean }

function RequestForm({ request, busy, onAnswer }: {
  request: PendingRequest
  busy: boolean
  onAnswer: (decision: 'accept' | 'decline' | 'cancel' | 'answer', answers?: Record<string, string | string[]>) => Promise<void>
}): React.JSX.Element {
  const [answers, setAnswers] = React.useState<Record<string, string | string[]>>({})
  const questions = Array.isArray(request.params.questions)
    ? request.params.questions.filter((item): item is Question =>
      typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.question === 'string')
    : []
  const isQuestion = questions.length > 0
  const offered = Array.isArray(request.params.availableDecisions)
    ? request.params.availableDecisions.filter((choice): choice is string => typeof choice === 'string')
    : null
  const mayApprove = !offered || offered.includes('accept')
  const negativeChoices: Array<'decline' | 'cancel'> = offered
    ? (['decline', 'cancel'] as const).filter((choice) => offered.includes(choice))
    : ['decline']
  const complete = questions.every((question) => {
    const value = answers[question.id]
    return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0
  })
  return <section className="approval" aria-label="Pending approval">
    <strong>{isQuestion ? 'Agent has a question' : 'Agent needs your approval'}</strong>
    {!isQuestion && <p>{requestSummary(request)}</p>}
    {questions.map((question) => <fieldset key={question.id}>
      <legend>{question.question}</legend>
      {question.multiSelect && question.options ? question.options.map((option) => {
        const current = Array.isArray(answers[question.id]) ? answers[question.id] as string[] : []
        return <label className="choice" key={option.label}><input type="checkbox" checked={current.includes(option.label)}
          onChange={(event) => setAnswers((prior) => ({ ...prior, [question.id]: event.target.checked
            ? [...current, option.label] : current.filter((value) => value !== option.label) }))} />{option.label}</label>
      }) : <>
        {question.options && <datalist id={`choices-${request.id}-${question.id}`}>
          {question.options.map((option) => <option key={option.label} value={option.label} />)}
        </datalist>}
        <input type={question.isSecret ? 'password' : 'text'} value={typeof answers[question.id] === 'string' ? answers[question.id] as string : ''}
          list={question.options ? `choices-${request.id}-${question.id}` : undefined}
          aria-label={question.question} onChange={(event) => setAnswers((prior) => ({ ...prior, [question.id]: event.target.value }))} />
      </>}
    </fieldset>)}
    <div className="approval-actions">
      {request.method !== 'item/tool/requestUserInput' && negativeChoices.map((choice) =>
        <button key={choice} disabled={busy} onClick={() => void onAnswer(choice)}>
          {choice === 'cancel' ? 'Cancel turn' : 'Decline'}</button>)}
      {(isQuestion || mayApprove) && <button disabled={busy || (isQuestion && !complete)} onClick={() => void onAnswer(isQuestion ? 'answer' : 'accept', isQuestion ? answers : undefined)}>
        {isQuestion ? 'Submit answer' : 'Approve'}
      </button>}
    </div>
  </section>
}

export function ConversationView({ conversation, bootId, accountLabel, fenced }: { conversation: Conversation; bootId: string | null;
  accountLabel: string; fenced: boolean }): React.JSX.Element {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null)
  const [draft, setDraft] = React.useState('')
  const [draftLoaded, setDraftLoaded] = React.useState(false)
  const [draftError, setDraftError] = React.useState('')
  const [sentDraftPendingClear, setSentDraftPendingClear] = React.useState(false)
  const [sendPending, setSendPending] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    let disposed = false
    const unsubscribe = window.adeHost.conversations.onDraftError((value) => {
      if (value.conversationId === conversation.id) setDraftError(value.message)
    })
    void window.adeHost.conversations.request('draft.get', { conversation_id: conversation.id }).then((response) => {
      if (disposed) return
      const saved = response.draft as { text: string }
      const sentText = typeof response.sent_text === 'string' ? response.sent_text : ''
      setDraft(sentText || saved.text)
      setSentDraftPendingClear(Boolean(sentText))
      setSendPending(Boolean(response.send_pending))
      setDraftError(typeof response.error === 'string' ? response.error : '')
      setDraftLoaded(true)
    }).catch((reason) => { if (!disposed) setDraftError(`Draft could not be loaded: ${String(reason)}`) })
    return () => { disposed = true; unsubscribe() }
  }, [conversation.id])

  const updateDraft = (text: string): void => {
    setDraft(text)
    void window.adeHost.conversations.request('draft.save', { conversation_id: conversation.id, text })
      .then((response) => { if (typeof response.error === 'string' && response.error) setDraftError(response.error) })
      .catch((reason) => setDraftError(`Draft could not be saved: ${String(reason)}`))
  }

  React.useEffect(() => startConversationProjection<Conversation, Message, PendingRequest>({
    conversationId: conversation.id,
    fetchSnapshot: async (conversationId, limit) => await window.adeHost.conversations.request('conversation.get',
      { conversation_id: conversationId, limit }) as Snapshot,
    subscribe: (listener) => window.adeHost.conversations.onFeedFrame(listener),
    onState: (state, cause) => {
      if (cause === 'failed') { setError(state.error ?? ''); return }
      if (cause === 'loaded') setError('')
      setSnapshot(state.snapshot)
    },
  }), [conversation.id, bootId, refresh])

  const send = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const text = draft.trim()
    if (fenced || !text || busy || sentDraftPendingClear || sendPending) return
    setBusy(true)
    try {
      const response = await window.adeHost.conversations.request('agent.send', {
        conversation_id: conversation.id, request_id: crypto.randomUUID(), text,
      })
      if (response.type === 'send_pending') {
        setSendPending(true)
        setError('')
        return
      }
      const clearError = typeof response.draft_error === 'string' ? response.draft_error : ''
      if (!clearError) setDraft('')
      setSendPending(false)
      setSentDraftPendingClear(Boolean(clearError))
      setDraftError(clearError)
      setError('')
      setRefresh((value) => value + 1)
    } catch (reason) {
      setError(String(reason))
      try {
        const state = await window.adeHost.conversations.request('draft.get', { conversation_id: conversation.id })
        setSendPending(Boolean(state.send_pending))
      } catch { /* Keep the pending state until the daemon can be queried again. */ }
    }
    finally { setBusy(false) }
  }
  const retryPendingSend = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await window.adeHost.conversations.request('agent.retry_send', { conversation_id: conversation.id })
      if (response.type === 'send_pending') { setError('Prompt delivery is still unconfirmed. Retry when the profile daemon is available.'); return }
      const clearError = typeof response.draft_error === 'string' ? response.draft_error : ''
      if (!clearError) setDraft('')
      setSendPending(false)
      setSentDraftPendingClear(Boolean(clearError))
      setDraftError(clearError)
      setError('')
      setRefresh((value) => value + 1)
    } catch (reason) {
      setError(String(reason))
      try {
        const state = await window.adeHost.conversations.request('draft.get', { conversation_id: conversation.id })
        setSendPending(Boolean(state.send_pending))
      } catch { /* Keep the pending state until the daemon can be queried again. */ }
    }
    finally { setBusy(false) }
  }
  const retryClear = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.adeHost.conversations.request('draft.flush', { conversation_id: conversation.id })
      setDraft('')
      setDraftError('')
      setSentDraftPendingClear(false)
    } catch (reason) { setDraftError(`Sent prompt draft could not be cleared: ${String(reason)}`) }
    finally { setBusy(false) }
  }
  const answer = async (request: PendingRequest, decision: 'accept' | 'decline' | 'cancel' | 'answer', answers?: Record<string, string | string[]>): Promise<void> => {
    if (fenced) return
    setBusy(true)
    try {
      await window.adeHost.conversations.request('agent.answer', {
        conversation_id: conversation.id, request_id: request.id, decision, answers,
      })
      setError('')
      setRefresh((value) => value + 1)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const control = async (action: 'cancel' | 'resume'): Promise<void> => {
    if (fenced || busy) return
    setBusy(true)
    try {
      await window.adeHost.conversations.request(`agent.${action}`, { conversation_id: conversation.id })
      setError('')
      setRefresh((value) => value + 1)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const status = snapshot?.conversation.status ?? conversation.status
  return (
    <section className="conversation-pane" aria-label="Conversation">
      <div className="conversation-heading">
        <div><h2>{conversation.title}</h2><p>{conversation.provider} · {accountLabel} · {status}</p></div>
        {['starting', 'running', 'waiting'].includes(status) &&
          <button type="button" disabled={fenced || busy} onClick={() => void control('cancel')}>Cancel turn</button>}
        {['disconnected', 'error', 'interrupted'].includes(status) &&
          <button type="button" disabled={fenced || busy} onClick={() => void control('resume')}>Resume agent</button>}
      </div>
      {error && <p role="alert" className="inline-error">{error}</p>}
      {draftError && <p role="alert" className="inline-error">{draftError}</p>}
      {sendPending && <p role="status" className="inline-error">Prompt delivery is unconfirmed. Retry uses the same request ID and prompt.</p>}
      <div className="transcript" role="log" aria-label="Conversation transcript" aria-live="polite">
        {!snapshot && !error && <p className="muted">Loading conversation…</p>}
        {snapshot?.messages.length === 0 && <p className="muted">Send a prompt to start this conversation.</p>}
        {snapshot?.messages.map((message) => (
          <article className={`message message-${message.role}`} key={message.id} data-message-id={message.id}>
            <div className="message-meta"><strong>{message.role}</strong><span>{message.kind} · {message.status}</span></div>
            <pre>{contentSummary(message)}</pre>
          </article>
        ))}
        {snapshot?.requests.map((request) => <RequestForm key={request.id} request={request} busy={busy || fenced}
          onAnswer={(decision, answers) => answer(request, decision, answers)} />)}
      </div>
      {fenced && <p role="status" className="inline-error">This workspace needs a replacement folder before agent actions can run. Its history remains readable.</p>}
      <form className="composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="prompt">Prompt</label>
        <textarea id="prompt" value={draft} disabled={busy || !draftLoaded || sentDraftPendingClear || sendPending} onChange={(event) => updateDraft(event.target.value)} placeholder="Ask your agent…" rows={3} />
        <button type="submit" disabled={fenced || busy || sentDraftPendingClear || sendPending || !draftLoaded || !draft.trim() || !snapshot || !['idle', 'ready', 'error', 'interrupted'].includes(status)}>Send</button>
        {sendPending && <button type="button" disabled={busy || fenced} onClick={() => void retryPendingSend()}>Retry prompt delivery</button>}
        {sentDraftPendingClear && <button type="button" disabled={busy} onClick={() => void retryClear()}>Retry clearing sent draft</button>}
      </form>
    </section>
  )
}
