import { z } from 'zod'
import type { Window } from '@ade/contracts'
import type { LayoutsBridge } from '../../../../../shared/bridge/layouts'
import { clampWidth, type Layout, type LayoutNode, type PaneNode, type Tab, type TabTarget } from './layout'
import type { DaemonStore } from '../../../state/daemon-store'
import { findPane, panes } from './layout-tree'
import { layoutStore } from './layout-store'

// The one-time import of the layouts this app saved in localStorage before the daemon owned them
// (daemon authority decision 9). On first connect, each saved layout of a workspace the daemon
// still has is stored with `layout.replace`, only where the daemon has none for this window
// (revision 0, checked again by the daemon through `expected_revision`); a layout the daemon
// already holds is never overwritten. Then the local keys are deleted.

/** Where the layouts were saved: per window name, and before that one key for the only window. */
const LAYOUT_KEYS = ['ade.layouts:main', 'ade.layouts']
const COLLAPSED_KEY = 'ade.navigator.collapsed:main'

const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), id: z.string() }),
  z.object({ kind: z.literal('terminal'), id: z.string() }),
  z.object({ kind: z.literal('browser'), id: z.string() }),
  z.object({ kind: z.literal('file'), path: z.string() }),
  z.object({ kind: z.literal('diff'), path: z.string(), staged: z.boolean() }),
  z.object({ kind: z.literal('new_conversation') }),
])
const savedTab = z.object({ id: z.string(), kind: z.string(), target: target.optional() })
const pane = z.object({
  type: z.literal('pane'),
  id: z.string(),
  tabs: z.array(z.string()),
  active: z.string().nullable(),
})
type SavedNode =
  | z.infer<typeof pane>
  | { type: 'split'; id: string; direction: 'row' | 'column'; children: SavedNode[]; sizes: number[] }
const node: z.ZodType<SavedNode> = z.lazy(() =>
  z.union([
    pane,
    z.object({
      type: z.literal('split'),
      id: z.string(),
      direction: z.enum(['row', 'column']),
      children: z.array(node).min(2),
      sizes: z.array(z.number()),
    }),
  ]),
)
const sidebar = z.enum(['navigator', 'inspector'])
const saved = z.object({
  sidebars: z.tuple([sidebar, sidebar]),
  collapsed: z.object({ navigator: z.boolean(), inspector: z.boolean() }),
  widths: z.object({ navigator: z.number(), inspector: z.number() }),
  tabs: z.record(z.string(), savedTab),
  root: node,
  focusedPane: z.string(),
  maximized: z.string().nullable().default(null),
})

/** What the daemon has, to keep only tabs whose records still exist. */
export interface Known {
  conversations: Set<string>
  terminals: Set<string>
}

const relativePath = (path: string): boolean =>
  path.length > 0 && !path.startsWith('/') && path.split('/').every((part) => part && part !== '.' && part !== '..')

/**
 * The target a saved tab becomes, or null to drop it: a tab from before tab targets that showed a
 * new conversation becomes `new_conversation`; one whose record is gone, and every browser tab
 * (browser tabs have no daemon records yet), is dropped.
 */
function importTarget(tab: z.infer<typeof savedTab>, known: Known): TabTarget | null {
  const saved = tab.target
  if (!saved) return tab.kind === 'conversation' ? { kind: 'new_conversation' } : null
  switch (saved.kind) {
    case 'conversation':
      return known.conversations.has(saved.id) ? saved : null
    case 'terminal':
      return known.terminals.has(saved.id) ? saved : null
    case 'file':
    case 'diff':
      return relativePath(saved.path) ? saved : null
    case 'new_conversation':
      return saved
    default:
      return null
  }
}

/** Split sizes the daemon takes: positive, summing to 100. */
function sizes(values: number[], count: number): number[] {
  const usable = values.length === count && values.every((size) => Number.isFinite(size) && size > 0)
  const base = usable ? values : Array.from({ length: count }, () => 1)
  const total = base.reduce((sum, size) => sum + size, 0)
  return base.map((size) => (size * 100) / total)
}

function convertNode(value: SavedNode, keep: (tabId: string) => boolean): LayoutNode {
  if (value.type === 'pane') {
    const tabs = value.tabs.filter(keep)
    const active = value.active && tabs.includes(value.active) ? value.active : (tabs[0] ?? null)
    return { type: 'pane', id: value.id, tabs, active } satisfies PaneNode
  }
  const children = value.children.map((child) => convertNode(child, keep))
  return {
    type: 'split',
    id: value.id,
    direction: value.direction,
    children,
    sizes: sizes(value.sizes, children.length),
  }
}

/** A saved layout in the daemon's shape, or null when it does not parse. */
export function convertSavedLayout(value: unknown, known: Known): Layout | null {
  const parsed = saved.safeParse(value)
  if (!parsed.success || parsed.data.sidebars[0] === parsed.data.sidebars[1]) return null
  const old = parsed.data
  const tabs: Record<string, Tab> = {}
  for (const [id, tab] of Object.entries(old.tabs)) {
    const converted = importTarget(tab, known)
    if (converted && tab.id === id) tabs[id] = { id, target: converted }
  }
  const root = convertNode(old.root, (tabId) => tabId in tabs)
  // Tabs no pane holds are not kept.
  const placed = new Set(panes(root).flatMap((item) => item.tabs))
  for (const id of Object.keys(tabs)) if (!placed.has(id)) delete tabs[id]
  const focused = findPane(root, old.focusedPane) ? old.focusedPane : panes(root)[0]!.id
  return {
    sidebars: old.sidebars,
    collapsed: old.collapsed,
    widths: { navigator: clampWidth(old.widths.navigator), inspector: clampWidth(old.widths.inspector) },
    tabs,
    root,
    focused_pane: focused,
    maximized: old.maximized === focused && root.type === 'split' ? focused : null,
  }
}

function read(key: string): unknown {
  try {
    const text = localStorage.getItem(key)
    return text === null ? undefined : (JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

/** Whether there is anything saved to import. */
export const hasSavedLayouts = (): boolean =>
  [...LAYOUT_KEYS, COLLAPSED_KEY].some((key) => {
    try {
      return localStorage.getItem(key) !== null
    } catch {
      return false
    }
  })

/**
 * Imports the saved layouts into this window, then deletes what it used. The old store held every
 * profile's workspaces in one key, so layouts of workspaces this profile does not have are written
 * back for that profile's first start. Keys stay when the daemon could not be reached, so the next
 * start tries again.
 */
export async function importSavedLayouts(
  bridge: LayoutsBridge,
  window: Window,
  workspaces: Set<string>,
  known: Known,
): Promise<void> {
  const layouts = new Map<string, unknown>()
  let shown: unknown
  // The per-window key wins over the older shared one.
  for (const key of [...LAYOUT_KEYS].reverse()) {
    const state = (read(key) as { state?: { active?: unknown; layouts?: Record<string, unknown> } } | undefined)?.state
    for (const [workspaceId, value] of Object.entries(state?.layouts ?? {})) layouts.set(workspaceId, value)
    shown = state?.active ?? shown
  }
  for (const [workspaceId, value] of layouts) {
    if (!workspaces.has(workspaceId) || (window.layouts[workspaceId] ?? 0) !== 0) continue
    const layout = convertSavedLayout(value, known)
    if (!layout) continue
    const outcome = await bridge.replace(workspaceId, layout, 0)
    if (!outcome.ok) console.warn(`Kept the daemon's layout of ${workspaceId}: ${outcome.message}`)
  }
  // A window that has shown nothing else yet shows the workspace the app showed last.
  if (
    typeof shown === 'string' &&
    workspaces.has(shown) &&
    shown !== window.workspace_id &&
    window.view.recent_workspaces.length <= 1
  )
    await bridge.showWorkspace(shown)
  const collapsed = read(COLLAPSED_KEY)
  if (
    window.view.collapsed_projects.length === 0 &&
    Array.isArray(collapsed) &&
    collapsed.length > 0 &&
    collapsed.every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
  )
    await bridge.setCollapsedProjects(collapsed as string[])
  for (const key of LAYOUT_KEYS) {
    const saved = read(key) as { state?: { layouts?: Record<string, unknown> } } | undefined
    // `default` was the pre-catalog placeholder, never a workspace of any profile.
    const others = Object.entries(saved?.state?.layouts ?? {}).filter(
      ([workspaceId]) => !workspaces.has(workspaceId) && workspaceId !== 'default',
    )
    if (others.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify({ state: { layouts: Object.fromEntries(others) }, version: 1 }))
  }
  localStorage.removeItem(COLLAPSED_KEY)
}

/**
 * Runs the import once, when the daemon's catalog and this window's record are both here and
 * something is saved. Returns the function that stops waiting.
 */
export function startLayoutImport(daemon: DaemonStore, bridge: () => LayoutsBridge | null): () => void {
  if (!hasSavedLayouts()) return () => undefined
  let started = false
  const attempt = (): void => {
    const state = daemon.getState()
    const { window } = layoutStore.getState()
    const target = bridge()
    if (started || state.status !== 'connected' || !window || !target) return
    started = true
    stop()
    const known: Known = {
      conversations: new Set(state.conversationIds),
      terminals: new Set(Object.keys(state.terminals)),
    }
    // One window imports at a time, across the app's windows; the next finds what is left.
    void navigator.locks
      .request('ade.layout-import', () =>
        hasSavedLayouts() ? importSavedLayouts(target, window, new Set(state.workspaceIds), known) : undefined,
      )
      .catch((error: unknown) =>
        console.warn('Could not import the saved layouts; they stay for the next start', error),
      )
  }
  const stops = [daemon.subscribe(attempt), layoutStore.subscribe(attempt)]
  const stop = (): void => stops.forEach((unsubscribe) => unsubscribe())
  attempt()
  return stop
}
