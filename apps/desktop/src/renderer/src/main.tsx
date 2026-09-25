import React from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientState, Workspace, Conversation, FeedFrame } from '@ade/client'
import { mountTerminal, type TerminalBridge } from '@ade/terminal'
import { ReviewPane } from './review'
import './style.css'

type Frame = Record<string, unknown>
type Message = { id: string; role: string; kind: string; text: string; status: string; sequence: number; content?: Frame }
type PendingRequest = { id: string; method: string; params: Frame }
type Snapshot = { conversation: Conversation; messages: Message[]; requests: PendingRequest[]; revision: number; boot_id: string }
type Provider = { id: string; name: string }
type Profile = { id: string; name: string; selected: boolean; home: string }
type ProfileState = { managed: boolean; profiles: Profile[]; selectedId: string | null; activeId: string | null; error: string }
type Service = { name: string; workspace_id: string; terminal_id: string | null; terminal_owner: Frame | null; ports: Record<string, number>; config: { program: string } }
type ServiceState = { state: string; metrics: Frame | null }
type ServiceList = { services: Service[]; states: Record<string, ServiceState> }

declare global {
  interface Window {
    adeHost: {
      getAppVersion(): Promise<string>
      getClientState(): Promise<ClientState>
      onClientState(listener: (state: ClientState) => void): () => void
      onFeedFrame(listener: (frame: FeedFrame) => void): () => void
      getProfileState(): Promise<ProfileState>
      listProfiles(): Promise<ProfileState>
      createProfile(name: string): Promise<ProfileState>
      selectProfile(id: string): Promise<ProfileState>
      onProfileState(listener: (state: ProfileState) => void): () => void
      openWorkspace(folder: string): Promise<Frame>
      chooseWorkspace(): Promise<Frame | null>
      selectWorkspace(id: string, conversationId: string | null): Promise<boolean>
      requestConversation(op: string, fields: Record<string, unknown>): Promise<Frame>
      requestService(op: string, fields: Record<string, unknown>): Promise<Frame>
      requestReview(op: string, fields: Record<string, unknown>): Promise<Frame>
      onDraftError(listener: (value: { conversationId: string; message: string }) => void): () => void
      terminal: TerminalBridge
    }
  }
}

function ServicePane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const [list, setList] = React.useState<ServiceList | null>(null)
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  React.useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const response = await window.adeHost.requestService('service.list', { workspace_id: workspace.id })
        if (!disposed) { setList(response as ServiceList); setError('') }
      } catch (reason) { if (!disposed) setError(String(reason)) }
    }
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => { disposed = true; clearInterval(timer) }
  }, [workspace.id, refresh])
  const change = async (name: string, action: 'start' | 'stop'): Promise<void> => {
    if (busy) return
    setBusy(name)
    try {
      await window.adeHost.requestService(`service.${action}`, { workspace_id: workspace.id, name })
      setError('')
      setRefresh((value) => value + 1)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy('') }
  }
  return <section className="service-pane" aria-label="Workspace services">
    <div className="service-heading"><h2>Services</h2><button onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div>
    <p className="muted">Configured services keep running when this window closes. Assigned ports do not confirm a listener.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {!list && !error && <p className="muted">Loading services…</p>}
    {list?.services.length === 0 && <p className="muted">No services configured in this workspace. Use the ADE CLI to add one.</p>}
    {list?.services.map((service) => {
      const state = list.states[service.name]?.state ?? 'unavailable'
      const owned = Boolean(service.terminal_owner)
      return <article className="service-row" key={service.name} aria-label={`Service ${service.name}`}>
        <div><strong>{service.name}</strong><span className="service-state">{state}</span></div>
        <p>{service.config.program}</p>
        <p className="service-ports">{Object.entries(service.ports).map(([variable, port]) => `${variable}=${port}`).join(' · ') || 'No assigned ports'}</p>
        <div className="service-actions">
          <button disabled={Boolean(busy) || owned} onClick={() => void change(service.name, 'start')}>Start</button>
          <button disabled={Boolean(busy) || !owned} onClick={() => void change(service.name, 'stop')}>Stop</button>
        </div>
      </article>
    })}
  </section>
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

function ConversationView({ conversation, bootId }: { conversation: Conversation; bootId: string | null }): React.JSX.Element {
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
    const unsubscribe = window.adeHost.onDraftError((value) => {
      if (value.conversationId === conversation.id) setDraftError(value.message)
    })
    void window.adeHost.requestConversation('draft.get', { conversation_id: conversation.id }).then((response) => {
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
    void window.adeHost.requestConversation('draft.save', { conversation_id: conversation.id, text })
      .then((response) => { if (typeof response.error === 'string' && response.error) setDraftError(response.error) })
      .catch((reason) => setDraftError(`Draft could not be saved: ${String(reason)}`))
  }

  React.useEffect(() => {
    let disposed = false
    let current: Snapshot | null = null
    let loading = false
    let reloadRequested = false
    let buffered: FeedFrame[] = []
    const apply = (frame: FeedFrame): void => {
      if (!current) { buffered.push(frame); if (!loading) void load(); return }
      if (frame.boot_id === current.boot_id && frame.revision <= current.revision) return
      if (frame.boot_id !== current.boot_id || frame.revision !== current.revision + 1) {
        current = null
        buffered = []
        reloadRequested = true
        if (!loading) { reloadRequested = false; void load() }
        return
      }
      if (frame.type === 'conversation_reload' &&
          (frame.conversation as Conversation | undefined)?.id === conversation.id) {
        current = null
        reloadRequested = true
        if (!loading) { reloadRequested = false; void load() }
        return
      }
      if (frame.type !== 'conversation_changed') {
        current = { ...current, revision: frame.revision }
        return
      }
      const changed = frame.conversation as Conversation | undefined
      if (!changed || changed.id !== conversation.id || !Array.isArray(frame.messages) || !Array.isArray(frame.requests)) {
        current = { ...current, revision: frame.revision }
        return
      }
      const messages = new Map(current.messages.map((message) => [message.id, message]))
      for (const item of frame.messages as Message[]) {
        if (item && typeof item.id === 'string') messages.set(item.id, item)
      }
      current = { ...current, conversation: changed,
        messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence).slice(-200),
        requests: frame.requests as PendingRequest[], revision: frame.revision }
      setSnapshot(current)
    }
    const load = async (): Promise<void> => {
      if (loading || disposed) return
      loading = true
      try {
        const value = await window.adeHost.requestConversation('conversation.get', { conversation_id: conversation.id }) as Snapshot
        if (!disposed) {
          current = value
          setSnapshot(value)
          setError('')
          const pending = buffered
          buffered = []
          for (const frame of pending) {
            if (frame.boot_id === value.boot_id && frame.revision <= (current?.revision ?? -1)) continue
            apply(frame)
            if (!current) break
          }
        }
      } catch (reason) {
        if (!disposed) setError(String(reason))
      } finally {
        loading = false
        if (!disposed && reloadRequested) { reloadRequested = false; void load() }
      }
    }
    const unsubscribe = window.adeHost.onFeedFrame(apply)
    void load()
    return () => { disposed = true; unsubscribe() }
  }, [conversation.id, bootId, refresh])

  const send = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy || sentDraftPendingClear || sendPending) return
    setBusy(true)
    try {
      const response = await window.adeHost.requestConversation('agent.send', {
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
        const state = await window.adeHost.requestConversation('draft.get', { conversation_id: conversation.id })
        setSendPending(Boolean(state.send_pending))
      } catch { /* Keep the pending state until the daemon can be queried again. */ }
    }
    finally { setBusy(false) }
  }
  const retryPendingSend = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await window.adeHost.requestConversation('agent.retry_send', { conversation_id: conversation.id })
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
        const state = await window.adeHost.requestConversation('draft.get', { conversation_id: conversation.id })
        setSendPending(Boolean(state.send_pending))
      } catch { /* Keep the pending state until the daemon can be queried again. */ }
    }
    finally { setBusy(false) }
  }
  const retryClear = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.adeHost.requestConversation('draft.flush', { conversation_id: conversation.id })
      setDraft('')
      setDraftError('')
      setSentDraftPendingClear(false)
    } catch (reason) { setDraftError(`Sent prompt draft could not be cleared: ${String(reason)}`) }
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
        {snapshot?.requests.map((request) => <RequestForm key={request.id} request={request} busy={busy}
          onAnswer={(decision, answers) => answer(request, decision, answers)} />)}
      </div>
      <form className="composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="prompt">Prompt</label>
        <textarea id="prompt" value={draft} disabled={busy || !draftLoaded || sentDraftPendingClear || sendPending} onChange={(event) => updateDraft(event.target.value)} placeholder="Ask your agent…" rows={3} />
        <button type="submit" disabled={busy || sentDraftPendingClear || sendPending || !draftLoaded || !draft.trim() || !snapshot || !['idle', 'ready', 'error', 'interrupted'].includes(status)}>Send</button>
        {sendPending && <button type="button" disabled={busy} onClick={() => void retryPendingSend()}>Retry prompt delivery</button>}
        {sentDraftPendingClear && <button type="button" disabled={busy} onClick={() => void retryClear()}>Retry clearing sent draft</button>}
      </form>
    </section>
  )
}

function ConnectedContent({ state, profileKey }: { state: ClientState; profileKey: string }): React.JSX.Element {
  const workspaces = state.catalog?.workspaces ?? []
  const conversations = state.catalog?.conversations ?? []
  const workspaceStorageKey = `ade.lastWorkspace.${profileKey}`
  const conversationStorageKey = `ade.lastConversation.${profileKey}`
  const [workspaceId, setWorkspaceId] = React.useState(() => localStorage.getItem(workspaceStorageKey) ?? '')
  const [conversationId, setConversationId] = React.useState(() => localStorage.getItem(conversationStorageKey) ?? '')
  const [provider, setProvider] = React.useState('codex')
  const [providers, setProviders] = React.useState<Provider[]>([])
  const [folderPath, setFolderPath] = React.useState('')
  const [opening, setOpening] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [pendingCreatedId, setPendingCreatedId] = React.useState<string | null>(null)
  const [acknowledgedSelection, setAcknowledgedSelection] = React.useState('')
  const selectionSequence = React.useRef(0)
  const visibleSelectionRequest = React.useRef(0)
  const [error, setError] = React.useState('')
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0]
  const workspaceConversations = conversations.filter((item) => item.workspace_id === workspace?.id)
  const selectedConversation = workspaceConversations.find((item) => item.id === conversationId)
  const awaitingCreated = pendingCreatedId === conversationId && !selectedConversation
  const conversation = awaitingCreated ? undefined : selectedConversation ?? workspaceConversations[0]
  const targetConversationId = awaitingCreated ? pendingCreatedId : conversation?.id ?? null
  const selectionKey = workspace ? `${workspace.id}:${targetConversationId ?? ''}` : ''
  React.useEffect(() => {
    if (!workspace) return
    const sequence = ++selectionSequence.current
    void window.adeHost.selectWorkspace(workspace.id, targetConversationId).then(() => {
      if (sequence === selectionSequence.current) setAcknowledgedSelection(selectionKey)
    }).catch((reason) => { if (sequence === selectionSequence.current) setError(String(reason)) })
    return () => { selectionSequence.current++ }
  }, [workspace?.id, targetConversationId, state.bootId])
  const selectVisible = async (workspaceId: string, nextConversationId: string | null): Promise<void> => {
    const request = ++visibleSelectionRequest.current
    ++selectionSequence.current
    await window.adeHost.selectWorkspace(workspaceId, nextConversationId)
    if (request !== visibleSelectionRequest.current) return
    setAcknowledgedSelection(`${workspaceId}:${nextConversationId ?? ''}`)
    setWorkspaceId(workspaceId)
    localStorage.setItem(workspaceStorageKey, workspaceId)
    setConversationId(nextConversationId ?? '')
    localStorage.setItem(conversationStorageKey, nextConversationId ?? '')
  }
  React.useEffect(() => {
    if (pendingCreatedId && conversations.some((item) => item.id === pendingCreatedId)) setPendingCreatedId(null)
  }, [pendingCreatedId, conversations])
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
    if (!workspace || creating || opening) return
    setCreating(true)
    try {
      const response = await window.adeHost.requestConversation('conversation.create', {
        workspace_id: workspace.id, title: 'New Conversation', provider,
      })
      const created = response.conversation as Conversation
      await selectVisible(workspace.id, created.id)
      setPendingCreatedId(created.id)
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setCreating(false) }
  }
  const openFolder = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (opening || creating || !folderPath.trim()) return
    setOpening(true)
    try {
      const result = await window.adeHost.openWorkspace(folderPath.trim())
      const opened = result.workspace as Workspace
      await selectVisible(opened.id, null)
      setFolderPath('')
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setOpening(false) }
  }
  const chooseFolder = async (): Promise<void> => {
    if (opening || creating) return
    setOpening(true)
    try {
      const result = await window.adeHost.chooseWorkspace()
      if (result) {
        const opened = result.workspace as Workspace
        await selectVisible(opened.id, null)
        setError('')
      }
    } catch (reason) { setError(String(reason)) }
    finally { setOpening(false) }
  }
  return (
    <div className="workspace-layout">
      <aside className="sidebar" aria-label="Workspace navigation">
        <h1>Workspaces</h1>
        <p className="connection-meta">Daemon boot: {state.bootId}</p>
        {workspaces.length === 0 && <p>No workspaces are registered in this profile yet.</p>}
        {workspaces.length > 0 && <label className="field-label" htmlFor="workspace">Workspace</label>}
        {workspaces.length > 0 && <select id="workspace" value={workspace?.id} disabled={creating || opening} onChange={(event) => {
          const nextId = event.target.value
          const firstConversation = conversations.find((item) => item.workspace_id === nextId)
          void selectVisible(nextId, firstConversation?.id ?? null).catch((reason) => setError(String(reason)))
        }}>
          {workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>}
        {workspace && <p className="workspace-root" title={workspace.root}>{workspace.root}</p>}
        <form className="open-workspace" onSubmit={(event) => void openFolder(event)}>
          <label className="field-label" htmlFor="folder-path">Open folder</label>
          <input id="folder-path" value={folderPath} placeholder="/path/to/project" onChange={(event) => setFolderPath(event.target.value)} />
          <div><button type="submit" disabled={opening || creating || !folderPath.trim()}>Open folder</button>
            <button type="button" disabled={opening || creating} onClick={() => void chooseFolder()}>Browse…</button></div>
        </form>
        <h2>Conversations</h2>
        <nav aria-label="Conversations"><ul className="conversation-list">
          {workspaceConversations.map((item) => <li key={item.id}><button disabled={creating || opening} className={conversation?.id === item.id ? 'selected' : ''} onClick={() => {
            if (workspace) void selectVisible(workspace.id, item.id).catch((reason) => setError(String(reason)))
          }}>{item.title}<small>{item.provider} · {item.status}</small></button></li>)}
        </ul></nav>
        <div className="new-conversation">
          <label className="field-label" htmlFor="provider">New conversation provider</label>
          <select id="provider" value={provider} disabled={creating || opening} onChange={(event) => setProvider(event.target.value)}>
            {providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
          <button disabled={creating || opening || !workspace || providers.length === 0} onClick={() => void create()}>New conversation</button>
        </div>
        {error && <p role="alert" className="inline-error">{error}</p>}
      </aside>
      <div className="work-area">
        {creating || awaitingCreated ? <section className="empty-conversation" role="status">Creating conversation…</section>
          : conversation ? <ConversationView key={conversation.id} conversation={conversation} bootId={state.bootId} />
          : <section className="empty-conversation"><h2>Start a conversation</h2><p>Choose a provider and create a conversation in this workspace.</p></section>}
        {workspace && <>{acknowledgedSelection === selectionKey && <ReviewPane key={`${profileKey}:${workspace.id}:${conversation?.id ?? ''}`}
          workspace={workspace} conversation={conversation} profileKey={profileKey} />}
          <ServicePane key={workspace.id} workspace={workspace} /><TerminalPane workspace={workspace} /></>}
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  const [state, setState] = React.useState<ClientState | null>(null)
  const [profile, setProfile] = React.useState<ProfileState | null>(null)
  const [newProfile, setNewProfile] = React.useState('')
  const [profileBusy, setProfileBusy] = React.useState(false)
  const [profileError, setProfileError] = React.useState('')
  const activeProfileId = React.useRef<string | null>(null)
  React.useEffect(() => {
    const unsubscribeClient = window.adeHost.onClientState(setState)
    const updateProfile = (next: ProfileState): void => {
      if (activeProfileId.current !== next.activeId) {
        activeProfileId.current = next.activeId
        setState(null)
      }
      setProfile(next)
    }
    let profileEventSeen = false
    const unsubscribeProfile = window.adeHost.onProfileState((next) => {
      profileEventSeen = true
      updateProfile(next)
    })
    void window.adeHost.getProfileState().then((next) => { if (!profileEventSeen) updateProfile(next) })
    const initialProfileId = activeProfileId.current
    void window.adeHost.getClientState().then((next) => {
      if (activeProfileId.current === initialProfileId) setState(next)
    })
    return () => { unsubscribeClient(); unsubscribeProfile() }
  }, [])
  const switchProfile = async (id: string): Promise<void> => {
    if (!id || profileBusy || id === profile?.activeId) return
    setProfileBusy(true)
    try { await window.adeHost.selectProfile(id); setProfileError('') }
    catch (error) { setProfileError(String(error)) }
    finally { setProfileBusy(false) }
  }
  const createProfile = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const name = newProfile.trim()
    if (!name || profileBusy) return
    setProfileBusy(true)
    try {
      const priorIds = new Set(profile?.profiles.map((item) => item.id))
      const next = await window.adeHost.createProfile(name)
      const created = next.profiles.find((item) => !priorIds.has(item.id))
      if (!created) throw new Error('Created profile was not returned by the launcher')
      await window.adeHost.selectProfile(created.id)
      setNewProfile('')
      setProfileError('')
    } catch (error) { setProfileError(String(error)) }
    finally { setProfileBusy(false) }
  }
  const active = profile?.profiles.find((item) => item.id === profile.activeId)
  return <main><header><span className="brand">ADE</span><div className="header-controls">
    {profile?.managed && <label className="profile-picker">Profile <select aria-label="Profile" value={profile.activeId ?? ''}
      disabled={profileBusy} onChange={(event) => void switchProfile(event.target.value)}>
      <option value="">Choose profile</option>
      {profile.profiles.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></label>}
    <span className="status" role="status">{state?.status ?? 'connecting'}</span></div></header>
    {profile?.managed && <div className="profile-bar">
      <span>{active ? `Active profile: ${active.name}` : 'No active profile'}</span>
      <form onSubmit={(event) => void createProfile(event)}><label htmlFor="new-profile">New profile</label>
        <input id="new-profile" value={newProfile} maxLength={80} onChange={(event) => setNewProfile(event.target.value)} placeholder="Profile name" />
        <button type="submit" disabled={profileBusy || !newProfile.trim()}>Create</button></form>
      {(profileError || profile.error) && <span role="alert" className="inline-error">{profileError || profile.error}</span>}
    </div>}
    {state?.status === 'connected' ? <ConnectedContent key={profile?.activeId ?? 'fixed'} profileKey={profile?.activeId ?? 'fixed'} state={state} /> : <section className="welcome">
      <h1>Work across agents, in one place.</h1><p role="status">{state?.detail ?? 'Checking profile daemon…'}</p>
    </section>}</main>
}

createRoot(document.getElementById('root')!).render(<App />)
