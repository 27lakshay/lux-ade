// The workspace layout as data: which sidebar sits on which side, which are collapsed, their widths,
// and the tree of panes in the centre with their tabs. Components read it; layout.logic.ts changes
// it. One layout per workspace (layout-store.ts).

/** The two sidebars. They only ever swap sides with each other and never hold panes. */
export type SidebarId = 'navigator' | 'inspector'
export type Side = 'left' | 'right'

export type TabKind = 'conversation' | 'terminal' | 'browser' | 'file' | 'diff'

export interface Tab {
  id: string
  kind: TabKind
  title: string
}

export type SplitDirection = 'row' | 'column'

export interface PaneNode {
  type: 'pane'
  id: string
  /** Tab ids, in strip order. */
  tabs: string[]
  active: string | null
}

export interface SplitNode {
  type: 'split'
  id: string
  /** row: side by side; column: stacked. */
  direction: SplitDirection
  children: LayoutNode[]
  /** Percentages of the split, one per child, summing to 100. */
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

/** Where a dragged tab or pane lands on a pane: one of its edges (a split) or its centre. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'centre'

/** An outer edge of the whole centre area, or a direction to a neighbouring pane. */
export type Edge = Exclude<DropZone, 'centre'>

export interface Layout {
  version: 1
  /** [left, right]. */
  sidebars: [SidebarId, SidebarId]
  collapsed: Record<SidebarId, boolean>
  /** Pixels. */
  widths: Record<SidebarId, number>
  tabs: Record<string, Tab>
  root: LayoutNode
  focusedPane: string
}

export const SIDEBAR_WIDTH = { navigator: 260, inspector: 340, min: 200, max: 480 } as const

export function defaultLayout(paneId: string): Layout {
  return {
    version: 1,
    sidebars: ['navigator', 'inspector'],
    collapsed: { navigator: false, inspector: false },
    widths: { navigator: SIDEBAR_WIDTH.navigator, inspector: SIDEBAR_WIDTH.inspector },
    tabs: {},
    root: { type: 'pane', id: paneId, tabs: [], active: null },
    focusedPane: paneId,
  }
}
