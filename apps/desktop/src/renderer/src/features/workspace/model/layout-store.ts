import { nanoid } from 'nanoid'
import { createStore, useStore } from 'zustand'
import type { Window } from '@ade/contracts'
import { toast } from '@/components/ui/toast'
import { hostErrorMessage } from '@/lib/host-error'
import type { LayoutOutcome, LayoutsBridge } from '../../../../../shared/bridge/layouts'
import { URL_WINDOW_ID } from '../../../app/window-id'
import {
  defaultLayout,
  type DropZone,
  type Edge,
  type Layout,
  type LayoutAction,
  type LayoutRecord,
  type Side,
  type SplitDirection,
  type TabTarget,
} from './layout'

// This window's layouts, as the daemon serves them: one per workspace the window has shown, each
// with its revision. The daemon applies every change (`layout.apply`); this store only holds what
// it last said (layout-sync.ts keeps it current) and sends gestures as actions once they end.
// `keepMounted` and `keepTerminals` are this viewer's performance settings, not daemon state.

export interface LayoutState {
  /** This window's daemon record; null until main has one. */
  windowId: string | null
  /** The record, from the daemon's catalog: the workspace it shows, its view state. */
  window: Window | null
  /** This window's layouts, by workspace. */
  records: Record<string, LayoutRecord>
  /** A workspace just chosen here, shown at once while the daemon records the switch. */
  pending: string | null
  /** How many recently shown workspaces keep their pane content mounted (hidden). */
  keepMounted: number
  /**
   * Of those, how many keep their terminals mounted (1: only the workspace on screen). A terminal
   * holds its scrollback and a GPU canvas, several MB each; one that unmounts attaches again from
   * the daemon when its workspace returns.
   */
  keepTerminals: number
}

export const layoutStore = createStore<LayoutState>()(() => ({
  windowId: URL_WINDOW_ID,
  window: null,
  records: {},
  pending: null,
  keepMounted: 3,
  keepTerminals: 1,
}))

/** What a window shows before the daemon has sent its layout. */
const PLACEHOLDER = defaultLayout()

/** The workspace on screen, or null before the daemon has named one. */
export const activeWorkspace = (state: LayoutState): string | null =>
  state.pending ?? state.window?.workspace_id ?? null

const layoutOf = (state: LayoutState, workspaceId: string | null): Layout =>
  (workspaceId && state.records[workspaceId]?.layout) || PLACEHOLDER

export const activeLayout = (state: LayoutState): Layout => layoutOf(state, activeWorkspace(state))

/** The layout on screen now. */
export const layoutNow = (): Layout => activeLayout(layoutStore.getState())

/** The workspaces whose content stays mounted: the one on screen first, then the most recent. */
export function keptWorkspaces(state: LayoutState): string[] {
  const active = activeWorkspace(state)
  const recent = state.window?.view.recent_workspaces ?? []
  return [...new Set(active ? [active, ...recent] : recent)].slice(0, state.keepMounted)
}

/** Reads the layout on screen through a selector. */
export const useLayout = <T>(selector: (layout: Layout) => T): T =>
  useStore(layoutStore, (state) => selector(activeLayout(state)))

let bridge: LayoutsBridge | null = null

/** Where layout commands go: main's bridge in the app, a fake daemon in tests and `?bench`. */
export function setLayoutBridge(next: LayoutsBridge | null): void {
  bridge = next
}

export function layoutBridge(): LayoutsBridge | null {
  return bridge
}

/** Keeps a layout the daemon sent, unless one of a later revision is already here. */
export function acceptLayout(record: LayoutRecord): void {
  layoutStore.setState((state) => {
    const held = state.records[record.workspace_id]
    if (record.window_id !== state.windowId || (held && held.revision >= record.revision)) return state
    return { records: { ...state.records, [record.workspace_id]: record } }
  })
}

function notConnected(): void {
  toast.add({ type: 'error', title: 'Not connected to ADE yet', description: 'Try again in a moment.' })
}

/** Shows why the daemon refused a change the person made, and reads the layout again if it moved on. */
export function refused(workspaceId: string, outcome: Exclude<LayoutOutcome, { ok: true }>): void {
  if (outcome.code === 'layout_conflict') {
    void refetchLayout(workspaceId)
    toast.add({ title: 'The layout changed', description: 'It was changed elsewhere; try again.' })
    return
  }
  toast.add({ type: 'error', title: 'Could not change the layout', description: outcome.message })
}

/** Reads one layout again (layout-sync.ts sets how). */
let refetchLayout: (workspaceId: string) => Promise<void> = async () => {}
export function setRefetch(refetch: (workspaceId: string) => Promise<void>): void {
  refetchLayout = refetch
}

/** Actions that move a pane relative to where it is: the daemon wants the revision they were made on. */
const RELATIVE = new Set<LayoutAction['type']>(['move_pane', 'swap_panes', 'dock_pane'])

/**
 * Sends one action for a workspace's layout and keeps the result; null when it was refused or
 * could not be sent (the person is told why).
 */
async function applyTo(workspaceId: string, action: LayoutAction): Promise<LayoutRecord | null> {
  if (!bridge) {
    notConnected()
    return null
  }
  const held = layoutStore.getState().records[workspaceId]
  try {
    const outcome = await bridge.apply(
      workspaceId,
      action,
      RELATIVE.has(action.type) ? (held?.revision ?? 0) : undefined,
    )
    if (!outcome.ok) {
      refused(workspaceId, outcome)
      return null
    }
    acceptLayout(outcome.layout)
    return outcome.layout
  } catch (error) {
    toast.add({ type: 'error', title: 'Could not change the layout', description: hostErrorMessage(error) })
    return null
  }
}

/** Sends an action for the layout on screen. */
export function dispatch(action: LayoutAction): Promise<LayoutRecord | null> {
  const workspaceId = activeWorkspace(layoutStore.getState())
  if (!workspaceId) {
    notConnected()
    return Promise.resolve(null)
  }
  return applyTo(workspaceId, action)
}

export function setKeepMounted(count: number): void {
  layoutStore.setState({ keepMounted: Math.max(1, Math.round(count)) })
}

export function setKeepTerminals(count: number): void {
  layoutStore.setState({ keepTerminals: Math.max(1, Math.round(count)) })
}

const newPaneId = (): string => `pane-${nanoid(8)}`

/** A tab's ID: a record's tab is named after it, so opening it again brings the same tab forward. */
const tabIdFor = (target: TabTarget): string =>
  'id' in target && typeof target.id === 'string' ? `tab-${target.id}` : `tab-${nanoid(8)}`

// Actions that need new IDs, or name the state a toggle reaches.
export const openTab = (target: TabTarget, paneId?: string) =>
  dispatch({ type: 'open_tab', tab: { id: tabIdFor(target), target }, pane_id: paneId ?? null })
export const openTabInAnother = (target: TabTarget, paneId?: string) =>
  dispatch({ type: 'open_tab', tab: { id: `tab-${nanoid(8)}`, target }, pane_id: paneId ?? null })
export const splitPane = (paneId: string, direction: SplitDirection) =>
  dispatch({ type: 'split_pane', pane_id: paneId, direction, new_pane_id: newPaneId() })
export const dropTab = (tabId: string, paneId: string, zone: DropZone) =>
  dispatch({ type: 'drop_tab', tab_id: tabId, pane_id: paneId, zone, new_pane_id: newPaneId() })
export const dockTab = (tabId: string, edge: Edge) =>
  dispatch({ type: 'dock_tab', tab_id: tabId, edge, new_pane_id: newPaneId() })
export const toggleSide = (side: Side) => {
  const layout = layoutNow()
  const sidebar = layout.sidebars[side === 'left' ? 0 : 1]
  return dispatch({ type: 'set_side_collapsed', side, collapsed: !layout.collapsed[sidebar] })
}
export const swapSidebars = () => dispatch({ type: 'set_sidebar_sides', left: layoutNow().sidebars[1] })
export const toggleMaximize = (paneId: string) =>
  dispatch({ type: 'set_maximized', pane_id: layoutNow().maximized === paneId ? null : paneId })
