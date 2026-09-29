import { toast } from '@/components/ui/toast'
import { hostErrorMessage } from '@/lib/host-error'
import type { LayoutOutcome } from '../../../../../shared/bridge/layouts'
import { confirm } from '../../../provisional/ConfirmDialog'
import { acceptLayout, activeWorkspace, layoutBridge, layoutStore, refused } from '../model/layout-store'

// Opening and closing tabs that hold terminals. A new terminal is one daemon command that starts a
// shell and opens its tab (`terminal.create` with `place`). Every close in the window (the tab's ×,
// middle-click, ⌘W, closing a pane) is `tab.close` or `pane.close`: the daemon closes the tab and
// stops the shell whose last tab it was, and refuses while a command runs in it until the person
// confirms ending that command. Other tabs just leave the layout.

const shownWorkspace = (): string | null => activeWorkspace(layoutStore.getState())

/** Starts a shell in the shown workspace, with its tab in `paneId` or the focused pane. */
export async function newTerminal(paneId?: string): Promise<void> {
  const workspaceId = shownWorkspace()
  if (!window.adeHost || !workspaceId) {
    toast.add({ type: 'error', title: 'No workspace to start a terminal in', description: 'Add a project first.' })
    return
  }
  try {
    // The tab arrives with the daemon's layout change, in whichever workspace the terminal runs.
    await window.adeHost.terminals.create(workspaceId, paneId)
  } catch (error) {
    toast.add({ type: 'error', title: 'Could not start a terminal', description: hostErrorMessage(error) })
  }
}

/** Asks before ending the commands a close would stop. */
function confirmStop(outcome: Extract<LayoutOutcome, { ok: false }>, what: 'tab' | 'pane'): Promise<boolean> {
  const running = outcome.terminals.map((terminal) => terminal.foreground).filter((name) => name !== null)
  const one = outcome.terminals.length === 1
  return confirm({
    title:
      one && running[0] ? `Stop “${running[0]}”?` : one ? 'Stop the running command?' : 'Stop the running commands?',
    description:
      what === 'tab'
        ? 'Closing this terminal ends the command running in it.'
        : `Closing this pane ends ${one ? 'the command' : 'the commands'} running in its terminals.`,
    confirmLabel: what === 'tab' ? 'Close terminal' : 'Close pane',
    destructive: true,
  })
}

async function close(
  what: 'tab' | 'pane',
  run: (workspaceId: string, force: boolean) => Promise<LayoutOutcome> | undefined,
): Promise<void> {
  const workspaceId = shownWorkspace()
  if (!workspaceId) return
  try {
    let outcome = await run(workspaceId, false)
    if (!outcome) return
    if (!outcome.ok && outcome.code === 'terminal_busy') {
      if (!(await confirmStop(outcome, what))) return
      outcome = await run(workspaceId, true)
      if (!outcome) return
    }
    if (outcome.ok) acceptLayout(outcome.layout)
    else refused(workspaceId, outcome)
  } catch (error) {
    toast.add({ type: 'error', title: `Could not close the ${what}`, description: hostErrorMessage(error) })
  }
}

/** Closes a tab of the shown workspace, and its shell when this was the shell's last tab. */
export const closeTab = (tabId: string): Promise<void> =>
  close('tab', (workspaceId, force) => layoutBridge()?.closeTab(workspaceId, tabId, force))

/** Closes a pane of the shown workspace and its tabs, and the shells whose last tabs they were. */
export const closePane = (paneId: string): Promise<void> =>
  close('pane', (workspaceId, force) => layoutBridge()?.closePane(workspaceId, paneId, force))
