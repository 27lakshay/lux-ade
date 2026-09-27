import React from 'react'
import type { Workspace } from '@ade/client'
import { mountTerminal } from '@ade/terminal'

export function TerminalPane({ workspace }: { workspace: Workspace }): React.JSX.Element {
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
