import React from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientState, Workspace } from '@ade/client'
import { mountTerminal, type TerminalBridge } from '@ade/terminal'
import './style.css'

declare global {
  interface Window {
    adeHost: {
      getAppVersion(): Promise<string>
      getClientState(): Promise<ClientState>
      onClientState(listener: (state: ClientState) => void): () => void
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

function WorkspaceList({ state }: { state: ClientState }): React.JSX.Element {
  if (!state.catalog?.workspaces.length) return <p>No workspaces are registered in this profile yet.</p>
  return (
    <ul className="workspace-list">
      {state.catalog.workspaces.map((workspace) => (
        <li key={workspace.id}>
          <strong>{workspace.name}</strong>
          <span>{workspace.root}</span>
          <small>{state.catalog?.conversations.filter((conversation) => conversation.workspace_id === workspace.id).length ?? 0} conversations</small>
        </li>
      ))}
    </ul>
  )
}

function ConnectedContent({ state }: { state: ClientState }): React.JSX.Element {
  return (
    <>
      <h1>Your workspaces</h1>
      <p>Connected to the profile daemon.</p>
      <p className="connection-meta">Daemon boot: {state.bootId}</p>
      <WorkspaceList state={state} />
      {state.catalog?.workspaces[0] && <TerminalPane workspace={state.catalog.workspaces[0]} />}
    </>
  )
}

function ConnectionContent({ state }: { state: ClientState | null }): React.JSX.Element {
  if (state?.status === 'connected') return <ConnectedContent state={state} />
  return (
    <>
      <h1>Work across agents, in one place.</h1>
      <p role="status">{state?.detail ?? 'Checking profile daemon…'}</p>
    </>
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

  return (
    <main>
      <header>
        <span className="brand">ADE</span>
        <span className="status" role="status">{state?.status ?? 'connecting'}</span>
      </header>
      <section className="welcome">
        <p className="eyebrow">Your development environment</p>
        <ConnectionContent state={state} />
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
