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
import { WINDOW_NAME } from '../../../app/window-name'

// Layouts, one per workspace in each window, saved across launches under the window's name
// (WINDOW_NAME): two windows on one workspace keep their own arrangements. `recent` lists the workspaces whose pane
// content stays mounted (hidden) after switching away, most recent first; `keepMounted` sets how
// many (3 by default).

interface LayoutState {
  active: string
  layouts: Record<string, Layout>
  recent: string[]
  keepMounted: number
  /**
   * Of those, how many keep their terminals mounted (1: only the workspace on screen). A terminal
   * holds its scrollback and a GPU canvas, several MB each; one that unmounts attaches again from
   * the daemon when its workspace returns.
   */
  keepTerminals: number
}

export const STORAGE_KEY = `ade.layouts:${WINDOW_NAME}`
/** Where layouts were saved before each window had its own; the main window takes them over. */
const LEGACY_KEY = 'ade.layouts'
/** Until workspace selection is wired, every window shows this one. */
export const DEFAULT_WORKSPACE = 'default'

const newPaneId = (): string => `pane-${nanoid(8)}`

const SAVE_DELAY_MS = 200
let pending: { name: string; value: string } | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined

/** Writes any layout change still waiting to be saved. Runs as the window closes or reloads. */
export function flushLayouts(): void {
  clearTimeout(saveTimer)
  if (!pending) return
  localStorage.setItem(pending.name, pending.value)
  pending = null
}
window.addEventListener('pagehide', flushLayouts)
window.addEventListener('beforeunload', flushLayouts)

export const layoutStore = createStore<LayoutState>()(
  persist(
    (): LayoutState => ({
      active: DEFAULT_WORKSPACE,
      layouts: { [DEFAULT_WORKSPACE]: defaultLayout(newPaneId()) },
      recent: [DEFAULT_WORKSPACE],
      keepMounted: 3,
      keepTerminals: 1,
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => ({
        getItem: (name) =>
          (pending?.name === name ? pending.value : null) ??
          localStorage.getItem(name) ??
          (WINDOW_NAME === 'main' ? localStorage.getItem(LEGACY_KEY) : null),
        setItem: (name, value) => {
          // Batched: a burst of changes (a drag, a run of keys) is one write.
          pending = { name, value }
          clearTimeout(saveTimer)
          saveTimer = setTimeout(flushLayouts, SAVE_DELAY_MS)
        },
        removeItem: (name) => {
          if (pending?.name === name) pending = null
          localStorage.removeItem(name)
        },
      })),
      partialize: (state) => ({
        active: state.active,
        layouts: state.layouts,
        keepMounted: state.keepMounted,
        keepTerminals: state.keepTerminals,
      }),
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
        const keepTerminals =
          typeof persisted.keepTerminals === 'number' && persisted.keepTerminals >= 1
            ? persisted.keepTerminals
            : current.keepTerminals
        // The workspace this window showed last, if its layout is still here.
        const active =
          typeof persisted.active === 'string' && layouts[persisted.active] ? persisted.active : current.active
        return { ...current, active, layouts, keepMounted, keepTerminals, recent: [active] }
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

/**
 * Gives the layout kept under `from` to workspace `to`, when `to` has none yet: the window's layout
 * from before it knew the daemon's workspaces carries over to the first one it shows.
 */
export function adoptLayout(from: string, to: string): void {
  layoutStore.setState((state) => {
    const layout = state.layouts[from]
    if (!layout || state.layouts[to]) return state
    const { [from]: _moved, ...rest } = state.layouts
    return {
      layouts: { ...rest, [to]: layout },
      active: state.active === from ? to : state.active,
      recent: state.recent.map((id) => (id === from ? to : id)),
    }
  })
}

export function setKeepMounted(count: number): void {
  layoutStore.setState((state) => ({
    keepMounted: Math.max(1, Math.round(count)),
    recent: state.recent.slice(0, Math.max(1, Math.round(count))),
  }))
}

export function setKeepTerminals(count: number): void {
  layoutStore.setState({ keepTerminals: Math.max(1, Math.round(count)) })
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
