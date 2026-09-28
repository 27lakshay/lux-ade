import { toast } from '@/components/ui/toast'
import { hostErrorMessage } from '@/lib/host-error'
import { DEFAULT_WORKSPACE, dispatch, layoutStore, openTabIn } from '../model/layout-store'
import type { Tab } from '../model/layout'
import { findPane } from '../model/layout-tree'

// Terminal tabs: a new one starts a shell in the daemon first, then opens a tab on it; closing one
// stops its terminal first, and the tab closes only once the daemon has. Every close in the window
// (the tab's ×, middle-click, ⌘W, closing its pane) comes through here, so no shell is left running
// behind a closed tab.

/** Starts a shell in the shown workspace and opens a tab on it, in `paneId` or the focused pane. */
export async function newTerminal(paneId?: string): Promise<void> {
  const workspaceId = layoutStore.getState().active
  if (!window.adeHost || workspaceId === DEFAULT_WORKSPACE) {
    toast.add({ type: 'error', title: 'No workspace to start a terminal in', description: 'Add a project first.' })
    return
  }
  try {
    const id = await window.adeHost.terminals.create(workspaceId)
    // The window may show another workspace by now; the tab goes where the terminal runs.
    openTabIn(workspaceId, { kind: 'terminal', title: 'Terminal', target: { kind: 'terminal', id } }, paneId)
  } catch (error) {
    toast.add({ type: 'error', title: 'Could not start a terminal', description: hostErrorMessage(error) })
  }
}

const shownTab = (tabId: string): Tab | undefined => {
  const { layouts, active } = layoutStore.getState()
  return layouts[active]?.tabs[tabId]
}

const terminalOf = (tab: Tab | undefined): string | null => (tab?.target?.kind === 'terminal' ? tab.target.id : null)

/** Stops the terminal a tab shows; false when the daemon could not. */
async function stopTerminal(tab: Tab, terminalId: string): Promise<boolean> {
  try {
    await window.adeHost.terminals.close(layoutStore.getState().active, terminalId)
    return true
  } catch (error) {
    toast.add({ type: 'error', title: `Could not close “${tab.title}”`, description: hostErrorMessage(error) })
    return false
  }
}

/** Closes a tab of the shown workspace, stopping its terminal first. A tab with no terminal closes at once. */
export async function closeTab(tabId: string): Promise<void> {
  const tab = shownTab(tabId)
  const terminalId = terminalOf(tab)
  if (tab && terminalId !== null && !(await stopTerminal(tab, terminalId))) return
  dispatch({ type: 'closeTab', tabId })
}

/** Closes a pane of the shown workspace. A terminal that will not stop keeps its tab. */
export async function closePane(paneId: string): Promise<void> {
  const { layouts, active } = layoutStore.getState()
  const layout = layouts[active]
  const pane = layout && findPane(layout.root, paneId)
  if (!pane) return
  const terminals = pane.tabs.flatMap((tabId) => {
    const tab = layout.tabs[tabId]
    const terminalId = terminalOf(tab)
    return tab && terminalId !== null ? [{ tabId, tab, terminalId }] : []
  })
  if (terminals.length === 0) return dispatch({ type: 'closePane', paneId })
  const stopped = await Promise.all(terminals.map(({ tab, terminalId }) => stopTerminal(tab, terminalId)))
  if (stopped.every(Boolean)) return dispatch({ type: 'closePane', paneId })
  // Keep the terminals that are still running; close everything else in the pane.
  const kept = new Set(terminals.filter((_, index) => !stopped[index]).map(({ tabId }) => tabId))
  for (const tabId of pane.tabs) if (!kept.has(tabId)) dispatch({ type: 'closeTab', tabId })
}
