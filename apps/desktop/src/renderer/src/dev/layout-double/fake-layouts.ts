import type { Layout, LayoutAction, LayoutRecord, Window } from '@ade/contracts'
import type { BusyTerminal, LayoutOutcome, LayoutsBridge } from '../../../../shared/bridge/layouts'
import { defaultLayout } from '../../features/workspace/model/layout'
import { findPane, panes } from '../../features/workspace/model/layout-tree'
import type { LayoutConnection } from '../../features/workspace/model/layout-sync'
import { applyLayout, LayoutRefusal, RELATIVE } from './reducer'

// A fake daemon for one window's layouts, for renderer tests and `?bench`: it keeps window records
// and layouts with revisions, applies actions through the layout double (reducer.ts), refuses as
// the daemon does (`layout_conflict`, `terminal_busy`), and sends `layout_changed` frames. Terminal
// targets it is told are shells close with their last tab, refusing while busy unless forced.

type Frame = { type: string; [key: string]: unknown }

export interface FakeLayouts {
  connection: LayoutConnection
  /** The window record as the fake holds it. */
  window(): Window
  /** A workspace's layout as the fake holds it. */
  layout(workspaceId?: string): Layout
  revision(workspaceId?: string): number
  /**
   * Changes a layout as another client would (the CLI). `missed` drops what this window hears of
   * it: `frame` (the frame only, as while reconnecting) or `all` (the catalog too).
   */
  applyElsewhere(action: LayoutAction, options?: { workspaceId?: string; missed?: 'frame' | 'all' }): void
  /** Opens a terminal's tab as `terminal.create` with `place` does. */
  placeTerminal(terminalId: string, paneId?: string, workspaceId?: string): void
  /** Shell terminals: closing their last tab stops them; a foreground command makes them busy. */
  shells: Map<string, { foreground: string | null }>
  /** Every command the fake was sent, by name. */
  calls: string[]
}

const ok = (layout: LayoutRecord, changed: boolean): LayoutOutcome => ({ ok: true, layout, changed })
const refusal = (code: string, message: string, terminals: BusyTerminal[] = []): LayoutOutcome => ({
  ok: false,
  code,
  message,
  terminals,
})

export function createFakeLayouts(options: {
  workspaceId: string
  windowId?: string
  /** Layouts the window starts with, by workspace. */
  layouts?: Record<string, Layout>
}): FakeLayouts {
  const windowId = options.windowId ?? 'window-test'
  const records = new Map<string, LayoutRecord>()
  let window: Window = {
    id: windowId,
    workspace_id: options.workspaceId,
    state: 'open',
    bounds: null,
    view: { collapsed_projects: [], recent_workspaces: [options.workspaceId] },
    layouts: {},
  }
  const windowListeners = new Set<(windows: Record<string, Window>, session: string) => void>()
  const frameListeners = new Set<(frame: Frame) => void>()
  const calls: string[] = []
  const shells = new Map<string, { foreground: string | null }>()

  const record = (workspaceId: string): LayoutRecord =>
    records.get(workspaceId) ?? { window_id: windowId, workspace_id: workspaceId, revision: 0, layout: defaultLayout() }
  const publishWindow = (): void => {
    for (const listener of windowListeners) listener({ [windowId]: window }, 'fake')
  }
  const store = (workspaceId: string, layout: Layout, missed?: 'frame' | 'all'): LayoutRecord => {
    const next = { ...record(workspaceId), layout, revision: record(workspaceId).revision + 1 }
    records.set(workspaceId, next)
    window = { ...window, layouts: { ...window.layouts, [workspaceId]: next.revision } }
    if (!missed) for (const listener of frameListeners) listener({ type: 'layout_changed', layout: next })
    if (missed !== 'all') publishWindow()
    return next
  }
  for (const [workspaceId, layout] of Object.entries(options.layouts ?? {})) store(workspaceId, layout)

  /** Applies an action; a tab close that ends a busy shell refuses unless forced. */
  const change = (workspaceId: string, action: LayoutAction, force: boolean | null, expected?: number) => {
    const current = record(workspaceId)
    if (RELATIVE.has(action.type) && expected === undefined)
      return refusal('invalid_layout', 'Moving, swapping or docking a pane needs expected_revision')
    if (expected !== undefined && expected !== current.revision)
      return refusal('layout_conflict', `The layout is at revision ${current.revision}, not ${expected}`)
    let next: Layout
    try {
      next = applyLayout(current.layout, action)
    } catch (error) {
      if (error instanceof LayoutRefusal) return refusal('invalid_layout', error.message)
      throw error
    }
    const closing = Object.values(current.layout.tabs).filter(
      (tab) => !next.tabs[tab.id] && tab.target.kind === 'terminal' && shells.has(tab.target.id),
    )
    if (closing.length > 0 && force === null)
      return refusal('tab_close_required', 'Closing these tabs ends their terminals; close them with tab.close')
    const busy = closing.flatMap((tab) => {
      const id = (tab.target as { id: string }).id
      const foreground = shells.get(id)?.foreground
      return foreground ? [{ terminal_id: id, foreground }] : []
    })
    if (busy.length > 0 && !force) return refusal('terminal_busy', 'A command is running', busy)
    for (const tab of closing) shells.delete((tab.target as { id: string }).id)
    if (JSON.stringify(next) === JSON.stringify(current.layout)) return ok(current, false)
    return ok(store(workspaceId, next), true)
  }

  const bridge: LayoutsBridge = {
    windowId: async () => windowId,
    onWindowId: () => () => undefined,
    get: async (workspaceId) => {
      calls.push('layout.get')
      return record(workspaceId)
    },
    apply: async (workspaceId, action, expected) => {
      calls.push('layout.apply')
      return change(workspaceId, action, null, expected)
    },
    closeTab: async (workspaceId, tabId, force) => {
      calls.push('tab.close')
      return change(workspaceId, { type: 'close_tab', tab_id: tabId }, force)
    },
    closePane: async (workspaceId, paneId, force) => {
      calls.push('pane.close')
      return change(workspaceId, { type: 'close_pane', pane_id: paneId }, force)
    },
    showWorkspace: async (workspaceId) => {
      calls.push('window.show_workspace')
      const recent = [workspaceId, ...window.view.recent_workspaces.filter((id) => id !== workspaceId)]
      window = { ...window, workspace_id: workspaceId, view: { ...window.view, recent_workspaces: recent } }
      publishWindow()
      return window
    },
    setCollapsedProjects: async (projectIds) => {
      calls.push('window.set_view_state')
      window = { ...window, view: { ...window.view, collapsed_projects: projectIds } }
      publishWindow()
      return window
    },
  }

  return {
    connection: {
      bridge,
      windows: (listener) => {
        windowListeners.add(listener)
        listener({ [windowId]: window }, 'fake')
        return () => windowListeners.delete(listener)
      },
      frames: (listener) => {
        frameListeners.add(listener)
        return () => frameListeners.delete(listener)
      },
    },
    window: () => window,
    layout: (workspaceId = window.workspace_id) => record(workspaceId).layout,
    revision: (workspaceId = window.workspace_id) => record(workspaceId).revision,
    applyElsewhere: (action, { workspaceId = window.workspace_id, missed } = {}) => {
      store(workspaceId, applyLayout(record(workspaceId).layout, action), missed)
    },
    placeTerminal: (terminalId, paneId, workspaceId = window.workspace_id) => {
      const layout = record(workspaceId).layout
      const pane = (paneId && findPane(layout.root, paneId)) || findPane(layout.root, layout.focused_pane)
      store(
        workspaceId,
        applyLayout(layout, {
          type: 'open_tab',
          tab: { id: `tab-${terminalId}`, target: { kind: 'terminal', id: terminalId } },
          pane_id: (pane ?? panes(layout.root)[0]!).id,
        }),
      )
    },
    shells,
    calls,
  }
}
