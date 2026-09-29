// Windows in the catalog (daemon authority ticket 07): each window's record,
// kept current from `window_changed`, with the revision of each of its
// layouts kept current from `layout_changed` and `layout_removed`. A client
// that missed feed frames compares `Window.layouts` with the layout revisions
// it holds and reads each one that differs with `layout.get`.
import type {
  Layout,
  LayoutAction,
  LayoutNode,
  LayoutRecord,
  PaneNode,
  SplitNode,
  Tab,
  TabTarget,
  Window,
  WindowBounds,
  WindowView,
} from '@ade/contracts'

export type {
  Layout,
  LayoutAction,
  LayoutNode,
  LayoutRecord,
  PaneNode,
  SplitNode,
  Tab,
  TabTarget,
  Window,
  WindowBounds,
  WindowView,
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonEmpty)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function parseBounds(value: unknown): WindowBounds | null | undefined {
  if (value === null || value === undefined) return null
  const source = record(value)
  if (!source) return undefined
  const { x, y, width, height } = source
  return finite(x) && finite(y) && finite(width) && finite(height) ? { x, y, width, height } : undefined
}

/** A window as the daemon sends it, or null when it is malformed. */
export function parseWindow(value: unknown): Window | null {
  const source = record(value)
  if (!source || !nonEmpty(source.id) || !nonEmpty(source.workspace_id)) return null
  if (source.state !== 'open' && source.state !== 'closed') return null
  const bounds = parseBounds(source.bounds)
  const view = record(source.view)
  const layouts = record(source.layouts)
  if (bounds === undefined || !view || !layouts) return null
  if (!strings(view.collapsed_projects) || !strings(view.recent_workspaces)) return null
  if (!Object.values(layouts).every((revision) => Number.isSafeInteger(revision) && (revision as number) >= 0))
    return null
  return {
    id: source.id,
    workspace_id: source.workspace_id,
    state: source.state,
    bounds,
    view: { collapsed_projects: view.collapsed_projects, recent_workspaces: view.recent_workspaces },
    layouts: layouts as Record<string, number>,
  }
}

/** The catalog's windows, or null when the list or any window in it is malformed. */
export function parseWindows(value: unknown): Window[] | null {
  if (!Array.isArray(value)) return null
  const windows = value.map(parseWindow)
  return windows.includes(null) ? null : (windows as Window[])
}

/**
 * The windows after one feed frame, or undefined when the frame is not about
 * windows or layouts. A malformed frame of those kinds returns null.
 */
export function applyWindowFrame(windows: Window[], frame: Record<string, unknown>): Window[] | null | undefined {
  if (frame.type === 'window_changed') {
    const window = parseWindow(frame.window)
    if (!window) return null
    const index = windows.findIndex((item) => item.id === window.id)
    return index === -1 ? [...windows, window] : windows.map((item, at) => (at === index ? window : item))
  }
  if (frame.type === 'layout_changed') {
    const layout = record(frame.layout)
    const revision = layout?.revision
    if (!layout || !nonEmpty(layout.window_id) || !nonEmpty(layout.workspace_id)) return null
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) return null
    const workspaceId = layout.workspace_id
    return windows.map((item) =>
      item.id === layout.window_id && (item.layouts[workspaceId] ?? 0) < (revision as number)
        ? { ...item, layouts: { ...item.layouts, [workspaceId]: revision as number } }
        : item,
    )
  }
  if (frame.type === 'layout_removed') {
    if (!nonEmpty(frame.window_id) || !nonEmpty(frame.workspace_id)) return null
    const workspaceId = frame.workspace_id
    return windows.map((item) => {
      if (item.id !== frame.window_id || !(workspaceId in item.layouts)) return item
      const { [workspaceId]: _removed, ...layouts } = item.layouts
      return { ...item, layouts }
    })
  }
  return undefined
}
