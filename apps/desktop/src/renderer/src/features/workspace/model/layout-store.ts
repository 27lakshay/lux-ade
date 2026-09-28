import { nanoid } from 'nanoid'
import { createStore, useStore } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  defaultLayout,
  type DropZone,
  type Edge,
  type Layout,
  type Side,
  type SplitDirection,
  type Tab,
} from './layout'
import { layoutReducer, type LayoutAction } from './layout.logic'
import { parseLayout } from './layout-schema'

// Layouts, one per workspace, saved across launches. `recent` lists the workspaces whose pane
// content stays mounted (hidden) after switching away, most recent first; `keepMounted` sets how
// many (3 by default).

interface LayoutState {
  active: string
  layouts: Record<string, Layout>
  recent: string[]
  keepMounted: number
}

const STORAGE_KEY = 'ade.layouts'
/** Until workspace selection is wired, every window shows this one. */
export const DEFAULT_WORKSPACE = 'default'

const newPaneId = (): string => `pane-${nanoid(8)}`

export const layoutStore = createStore<LayoutState>()(
  persist(
    (): LayoutState => ({
      active: DEFAULT_WORKSPACE,
      layouts: { [DEFAULT_WORKSPACE]: defaultLayout(newPaneId()) },
      recent: [DEFAULT_WORKSPACE],
      keepMounted: 3,
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ layouts: state.layouts, keepMounted: state.keepMounted }),
      // Keep only layouts that still parse; anything else starts from the default.
      merge: (saved, current) => {
        const persisted = (saved ?? {}) as Partial<LayoutState>
        const layouts: Record<string, Layout> = { ...current.layouts }
        for (const [id, value] of Object.entries(persisted.layouts ?? {})) {
          const layout = parseLayout(value)
          if (layout) layouts[id] = layout
        }
        const keepMounted =
          typeof persisted.keepMounted === 'number' && persisted.keepMounted >= 1
            ? persisted.keepMounted
            : current.keepMounted
        return { ...current, layouts, keepMounted }
      },
    },
  ),
)

const activeLayout = (state: LayoutState): Layout => state.layouts[state.active] ?? defaultLayout(newPaneId())

/** Applies an action to the active workspace's layout. */
export function dispatch(action: LayoutAction): void {
  layoutStore.setState((state) => ({
    layouts: { ...state.layouts, [state.active]: layoutReducer(activeLayout(state), action) },
  }))
}

/** Shows another workspace's layout, creating a default one the first time. */
export function setActiveWorkspace(id: string): void {
  layoutStore.setState((state) => ({
    active: id,
    layouts: state.layouts[id] ? state.layouts : { ...state.layouts, [id]: defaultLayout(newPaneId()) },
    recent: [id, ...state.recent.filter((other) => other !== id)].slice(0, state.keepMounted),
  }))
}

export function setKeepMounted(count: number): void {
  layoutStore.setState((state) => ({
    keepMounted: Math.max(1, Math.round(count)),
    recent: state.recent.slice(0, Math.max(1, Math.round(count))),
  }))
}

/** Reads the active layout through a selector. */
export const useLayout = <T>(selector: (layout: Layout) => T): T =>
  useStore(layoutStore, (state) => selector(activeLayout(state)))

// Actions that need new ids.
export const openTab = (tab: Omit<Tab, 'id'>, paneId?: string): void =>
  dispatch({ type: 'openTab', tab: { ...tab, id: `tab-${nanoid(8)}` }, paneId })
export const splitPane = (paneId: string, direction: SplitDirection): void =>
  dispatch({ type: 'splitPane', paneId, direction, newPaneId: newPaneId() })
export const dropTab = (tabId: string, paneId: string, zone: DropZone): void =>
  dispatch({ type: 'dropTab', tabId, paneId, zone, newPaneId: newPaneId() })
export const dockTab = (tabId: string, edge: Edge): void =>
  dispatch({ type: 'dockTab', tabId, edge, newPaneId: newPaneId() })
export const toggleSide = (side: Side): void => dispatch({ type: 'toggleSide', side })
