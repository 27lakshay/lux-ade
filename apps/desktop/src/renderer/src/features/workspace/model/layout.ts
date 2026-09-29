// The workspace layout as data, in the daemon's own shape (`contract/layout.rs`): which sidebar
// sits on which side, which are collapsed, their widths, and the tree of panes in the centre with
// their tabs. The daemon owns and changes it; components read it (layout-store.ts) and send
// changes as `layout.apply` actions.

import type { Layout, TabTarget } from '@ade/contracts'

export type {
  DropZone,
  Edge,
  Layout,
  LayoutAction,
  LayoutNode,
  LayoutRecord,
  PaneNode,
  Side,
  SidebarId,
  SplitDirection,
  SplitNode,
  Tab,
  TabTarget,
} from '@ade/contracts'

/** What a tab shows, as far as its icon and minimum size go. */
export type TabKind = 'conversation' | 'terminal' | 'browser' | 'file' | 'diff'

/** A new conversation's composer is a conversation tab. */
export const tabKind = (target: TabTarget | undefined): TabKind =>
  !target || target.kind === 'new_conversation' ? 'conversation' : target.kind

export const SIDEBAR_WIDTH = { navigator: 260, inspector: 340, min: 200, max: 480 } as const

/** The pane the daemon gives every default layout. */
const DEFAULT_PANE = 'pane-main'

/** The layout a window has for a workspace it never changed, as the daemon serves it. */
export function defaultLayout(paneId = DEFAULT_PANE): Layout {
  return {
    sidebars: ['navigator', 'inspector'],
    collapsed: { navigator: false, inspector: false },
    widths: { navigator: SIDEBAR_WIDTH.navigator, inspector: SIDEBAR_WIDTH.inspector },
    tabs: {},
    root: { type: 'pane', id: paneId, tabs: [], active: null },
    focused_pane: paneId,
    maximized: null,
  }
}

/** A sidebar width as the daemon stores it: clamped to 200–480 and rounded to whole pixels. */
export const clampWidth = (width: number): number =>
  Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)))

/**
 * The smallest a pane may be, by what its tabs show: a conversation needs room for its text, a
 * terminal about 40 columns. A pane takes the largest of its tabs' minimums.
 */
export const PANE_MIN = {
  width: { conversation: 360, terminal: 320, browser: 320, file: 320, diff: 360, empty: 240 },
  height: 160,
} as const

/** The gutter between cards and between panes, in pixels. */
export const GUTTER = 8
