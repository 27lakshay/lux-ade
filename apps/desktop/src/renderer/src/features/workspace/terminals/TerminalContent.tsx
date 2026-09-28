import { mountTerminal } from '@ade/terminal'
import { useEffect, useRef, useState } from 'react'
import { toast } from '@/components/ui/toast'
import { hostErrorMessage } from '@/lib/host-error'
import { TerminalStatus } from '../../../provisional/TerminalStatus'

// A terminal tab's content: the daemon's terminal drawn by Ghostty (packages/terminal). Output goes
// from the stream bridge to Ghostty without passing through React. A pane attaches this tab's host
// element only while the tab is shown, so the view draws only while it has a size. When the stream
// closes (a restarted bridge or daemon), it attaches again a few times, then says why and offers to
// reconnect or restart the shell.

/** Attempts to attach again after the stream closes, before asking the person. */
const RETRIES = 3

function TerminalView({
  workspaceId,
  terminalId,
  onClosed,
}: {
  workspaceId: string
  terminalId: string
  onClosed: (message: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const view = mountTerminal(element, window.adeHost.terminal, workspaceId, terminalId, { onStatus: onClosed })
    const observer = new ResizeObserver(([entry]) => {
      view.setVisible(Boolean(entry && entry.contentRect.width > 0 && entry.contentRect.height > 0))
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      view.dispose()
    }
    // onClosed is a new function each render; the attachment must not restart for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attach once per terminal and attempt
  }, [workspaceId, terminalId])
  return <div ref={container} className="h-full" data-terminal={terminalId} />
}

export function TerminalContent({ workspaceId, terminalId }: { workspaceId: string; terminalId: string }) {
  // Each attempt mounts a fresh view, which attaches again and restores from the daemon's snapshot.
  const [attempt, setAttempt] = useState(0)
  const [failures, setFailures] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (status === null || failures >= RETRIES) return
    const timer = setTimeout(
      () => {
        setFailures((count) => count + 1)
        setStatus(null)
        setAttempt((count) => count + 1)
      },
      500 * 2 ** failures,
    )
    return () => clearTimeout(timer)
  }, [status, failures])

  const reconnect = (): void => {
    setFailures(0)
    setStatus(null)
    setAttempt((count) => count + 1)
  }
  const restart = (): void => {
    window.adeHost.terminals
      .restart(workspaceId, terminalId)
      .then(reconnect, (error: unknown) =>
        toast.add({ type: 'error', title: 'Could not restart the shell', description: hostErrorMessage(error) }),
      )
  }

  return (
    <div className="relative h-full bg-terminal">
      <TerminalView key={attempt} workspaceId={workspaceId} terminalId={terminalId} onClosed={setStatus} />
      {status !== null && failures >= RETRIES && (
        <TerminalStatus message={status} onReconnect={reconnect} onRestart={restart} />
      )}
    </div>
  )
}
