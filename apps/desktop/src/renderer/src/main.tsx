import React from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientState, Workspace, Conversation } from '@ade/client'
import { mountTerminal, type TerminalBridge } from '@ade/terminal'
import './style.css'

type Frame = Record<string, unknown>
type Message = { id: string; role: string; kind: string; text: string; status: string; sequence: number; content?: Frame }
type PendingRequest = { id: string; method: string; params: Frame }
type Snapshot = { conversation: Conversation; messages: Message[]; requests: PendingRequest[]; revision: number; boot_id: string }
type Provider = { id: string; name: string }

declare global {
  interface Window {
    adeHost: {
      getAppVersion(): Promise<string>
      getClientState(): Promise<ClientState>
      onClientState(listener: (state: ClientState) => void): () => void
      requestConversation(op: string, fields: Record<string, unknown>): Promise<Frame>
      terminal: TerminalBridge
    }
  }
}

function TerminalPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const container = React.useRef<HTMLDivElement>(null)
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    if (!container.current) return
    const view = mountTerminal(container.current, window.adeHost.terminal,
      workspace.id, workspace.terminal_id, setMessage)
    return () => view.dispose()
  }, [workspace.id, workspace.terminal_id])

  return (
    <section className="terminal-pane" aria-label={`${workspace.name} terminal`}>
      <h2>Terminal · {workspace.name}</h2>
      {message && <p role="alert">{message}</p>}
      <div className="terminal-surface" ref={container} />
    </section>
  )
}

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
  onAnswer: (decision: 'accept' | 'decline' | 'answer', answers?: Record<string, string | string[]>) => Promise<void>
}): React.JSX.Element {
  const [answers, setAnswers] = React.useState<Record<string, string | string[]>>({})
  const questions = Array.isArray(request.params.questions)
    ? request.params.questions.filter((item): item is Question =>
      typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.question === 'string')
    : []
  const isQuestion = questions.length > 0
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
      {request.method !== 'item/tool/requestUserInput' && <button disabled={busy} onClick={() => void onAnswer('decline')}>Decline</button>}
      <button disabled={busy || (isQuestion && !complete)} onClick={() => void onAnswer(isQuestion ? 'answer' : 'accept', isQuestion ? answers : undefined)}>
        {isQuestion ? 'Submit answer' : 'Approve'}
      </button>
    </div>
  </section>
}

function ConversationView({ conversation, revision, bootId }: { conversation: Conversation; revision: number | null; bootId: string | null }): React.JSX.Element {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null)
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const value = await window.adeHost.requestConversation('conversation.get', { conversation_id: conversation.id }) as Snapshot
        if (!disposed) { setSnapshot(value); setError('') }
      } catch (reason) {
        if (!disposed) setError(String(reason))
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 2_000)
    return () => { disposed = true; clearInterval(timer) }
  }, [conversation.id, revision, bootId, refresh])

  const send = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await window.adeHost.requestConversation('agent.send', {
        conversation_id: conversation.id, request_id: crypto.randomUUID(), text,
      })
      setDraft('')
      setError('')
      setRefresh((value) => value + 1)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const answer = async (request: PendingRequest, decision: 'accept' | 'decline' | 'answer', answers?: Record<string, string | string[]>): Promise<void> => {
    setBusy(true)
    try {
      await window.adeHost.requestConversation('agent.answer', {
        conversation_id: conversation.id, request_id: request.id, decision, answers,
      })
      setError('')
      setRefresh((value) => value + 1)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const status = snapshot?.conversation.status ?? conversation.status
  return (
    <section className="conversation-pane" aria-label="Conversation">
      <div className="conversation-heading">
        <div><h2>{conversation.title}</h2><p>{conversation.provider} · {status}</p></div>
      </div>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <div className="transcript" role="log" aria-label="Conversation transcript" aria-live="polite">
        {!snapshot && !error && <p className="muted">Loading conversation…</p>}
        {snapshot?.messages.length === 0 && <p className="muted">Send a prompt to start this conversation.</p>}
        {snapshot?.messages.map((message) => (
          <article className={`message message-${message.role}`} key={message.id} data-message-id={message.id}>
            <div className="message-meta"><strong>{message.role}</strong><span>{message.kind} · {message.status}</span></div>
            <pre>{contentSummary(message)}</pre>
          </article>
        ))}
        {snapshot?.requests.map((request) => <RequestForm key={request.id} request={request} busy={busy}
          onAnswer={(decision, answers) => answer(request, decision, answers)} />)}
      </div>
      <form className="composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="prompt">Prompt</label>
        <textarea id="prompt" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask your agent…" rows={3} />
        <button type="submit" disabled={busy || !draft.trim() || !snapshot || !['idle', 'ready', 'error', 'interrupted'].includes(status)}>Send</button>
      </form>
    </section>
  )
}

function ConnectedContent({ state }: { state: ClientState }): React.JSX.Element {
  const workspaces = state.catalog?.workspaces ?? []
  const conversations = state.catalog?.conversations ?? []
  const [workspaceId, setWorkspaceId] = React.useState('')
  const [conversationId, setConversationId] = React.useState(() => localStorage.getItem('ade.lastConversation') ?? '')
  const [provider, setProvider] = React.useState('codex')
  const [providers, setProviders] = React.useState<Provider[]>([])
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState('')
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0]
  const workspaceConversations = conversations.filter((item) => item.workspace_id === workspace?.id)
  const conversation = workspaceConversations.find((item) => item.id === conversationId) ?? workspaceConversations[0]
  React.useEffect(() => {
    let disposed = false
    void window.adeHost.requestConversation('provider.list', {}).then((response) => {
      if (disposed || !Array.isArray(response.providers)) return
      const found = response.providers.filter((item): item is Provider =>
        typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.name === 'string')
      setProviders(found)
      if (found.length && !found.some((item) => item.id === provider)) setProvider(found[0].id)
    }).catch((reason) => { if (!disposed) setError(String(reason)) })
    return () => { disposed = true }
  }, [state.bootId])
  const create = async (): Promise<void> => {
    if (!workspace || creating) return
    setCreating(true)
    try {
      const response = await window.adeHost.requestConversation('conversation.create', {
        workspace_id: workspace.id, title: 'New Conversation', provider,
      })
      const created = response.conversation as Conversation
      setConversationId(created.id)
      localStorage.setItem('ade.lastConversation', created.id)
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setCreating(false) }
  }
  return (
    <div className="workspace-layout">
      <aside className="sidebar" aria-label="Workspace navigation">
        <h1>Workspaces</h1>
        <p className="connection-meta">Daemon boot: {state.bootId}</p>
        {workspaces.length === 0 && <p>No workspaces are registered in this profile yet.</p>}
        {workspaces.length > 0 && <label className="field-label" htmlFor="workspace">Workspace</label>}
        {workspaces.length > 0 && <select id="workspace" value={workspace?.id} onChange={(event) => { setWorkspaceId(event.target.value); setConversationId('') }}>
          {workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>}
        {workspace && <p className="workspace-root" title={workspace.root}>{workspace.root}</p>}
        <h2>Conversations</h2>
        <nav aria-label="Conversations"><ul className="conversation-list">
          {workspaceConversations.map((item) => <li key={item.id}><button className={conversation?.id === item.id ? 'selected' : ''} onClick={() => {
            setConversationId(item.id); localStorage.setItem('ade.lastConversation', item.id)
          }}>{item.title}<small>{item.provider} · {item.status}</small></button></li>)}
        </ul></nav>
        <div className="new-conversation">
          <label className="field-label" htmlFor="provider">New conversation provider</label>
          <select id="provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
            {providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
          <button disabled={creating || !workspace || providers.length === 0} onClick={() => void create()}>New conversation</button>
        </div>
        {error && <p role="alert" className="inline-error">{error}</p>}
      </aside>
      <div className="work-area">
        {conversation ? <ConversationView key={conversation.id} conversation={conversation} revision={state.revision} bootId={state.bootId} />
          : <section className="empty-conversation"><h2>Start a conversation</h2><p>Choose a provider and create a conversation in this workspace.</p></section>}
        {workspace && <TerminalPane workspace={workspace} />}
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  const [state, setState] = React.useState<ClientState | null>(null)
  React.useEffect(() => {
    const update = (next: ClientState): void => setState((previous) =>
      !previous || next.sequence >= previous.sequence ? next : previous)
    const unsubscribe = window.adeHost.onClientState(update)
    void window.adeHost.getClientState().then(update)
    return unsubscribe
  }, [])
  return <main><header><span className="brand">ADE</span><span className="status" role="status">{state?.status ?? 'connecting'}</span></header>
    {state?.status === 'connected' ? <ConnectedContent state={state} /> : <section className="welcome">
      <h1>Work across agents, in one place.</h1><p role="status">{state?.detail ?? 'Checking profile daemon…'}</p>
    </section>}</main>
}

createRoot(document.getElementById('root')!).render(<App />)
