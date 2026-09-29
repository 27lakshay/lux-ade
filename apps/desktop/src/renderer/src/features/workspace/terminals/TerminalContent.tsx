import { mountTerminal, type TerminalView as View } from '@ade/terminal'
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { toast } from '@/components/ui/toast'
import { hostErrorMessage } from '@/lib/host-error'
import { TerminalStatus } from '../../../provisional/TerminalStatus'
import { activeLayout, layoutStore } from '../model/layout-store'
import { findPane } from '../model/layout-tree'

// A terminal tab's content: the daemon's terminal drawn by Ghostty (packages/terminal). Output goes
// from the stream bridge to Ghostty without passing through React. A pane attaches this tab's host
// element only while the tab is shown, so the view draws only while it has a size. When the stream
// closes (a restarted bridge or daemon), it attaches again a few times, then says why and offers to
// reconnect or restart the shell. It takes the keyboard when its tab becomes the one shown in the
// focused pane: opened, chosen, or reached by moving between panes.

/** Attempts to attach again after the stream closes, before asking the person. */
const RETRIES = 3

/** Whether the tab is the one shown in the focused pane of the workspace on screen. */
const useFocusedTab = (tabId: string): boolean =>
  useStore(layoutStore, (state) => {
    const layout = activeLayout(state)
    return findPane(layout.root, layout.focused_pane)?.active === tabId
  })

function TerminalView({
  tabId,
  workspaceId,
  terminalId,
  onClosed,
}: {
  tabId: string
  workspaceId: string
  terminalId: string
  onClosed: (message: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<View | null>(null)
  const focused = useFocusedTab(tabId)
  useEffect(() => {
    if (!focused) return
    // The pane attaches this tab's host during the same commit, and a new view mounts in the effect
    // below; focus once both have happened. A view still starting takes the focus when it is ready.
    const frame = requestAnimationFrame(() => view.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [focused])
  useEffect(() => {
    const element = container.current
    if (!element) return
    const mounted = mountTerminal(element, window.adeHost.terminal, workspaceId, terminalId, { onStatus: onClosed })
    view.current = mounted
    const observer = new ResizeObserver(([entry]) => {
      mounted.setVisible(Boolean(entry && entry.contentRect.width > 0 && entry.contentRect.height > 0))
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      view.current = null
      mounted.dispose()
    }
    // onClosed is a new function each render; the attachment must not restart for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attach once per terminal and attempt
  }, [workspaceId, terminalId])
  return <div ref={container} className="h-full" data-terminal={terminalId} />
}

export function TerminalContent({
  tabId,
  workspaceId,
  terminalId,
}: {
  tabId: string
  workspaceId: string
  terminalId: string
}) {
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
      <TerminalView
        key={attempt}
        tabId={tabId}
        workspaceId={workspaceId}
        terminalId={terminalId}
        onClosed={setStatus}
      />
      {status !== null && failures >= RETRIES && (
        <TerminalStatus message={status} onReconnect={reconnect} onRestart={restart} />
      )}
    </div>
  )
}
