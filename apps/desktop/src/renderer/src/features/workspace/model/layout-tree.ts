import {
  GUTTER,
  PANE_MIN,
  tabKind,
  type DropZone,
  type Edge,
  type LayoutNode,
  type PaneNode,
  type SplitDirection,
  type SplitNode,
  type Tab,
} from './layout'

// The pane tree: queries. The daemon makes every change to it (`layout.apply`).

export function panes(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(panes)
}

export const findPane = (root: LayoutNode, id: string): PaneNode | undefined =>
  panes(root).find((pane) => pane.id === id)

export const paneOfTab = (root: LayoutNode, tabId: string): PaneNode | undefined =>
  panes(root).find((pane) => pane.tabs.includes(tabId))

/** A string that changes only when the tree's shape changes, never when sizes do. */
export function structureKey(node: LayoutNode): string {
  return node.type === 'pane' ? node.id : `${node.direction}(${node.children.map(structureKey).join(',')})`
}

/**
 * The pane next to `paneId` in a direction, as the eye sees it: the nearest split along that axis
 * where the pane is not already at the edge, then the closest pane on that side.
 */
export function neighbourPane(root: LayoutNode, paneId: string, edge: Edge): PaneNode | undefined {
  const direction = zoneDirection(edge)
  const forward = zoneAfter(edge)
  let id = paneId
  for (let parent = parentOf(root, id); parent; id = parent.id, parent = parentOf(root, id)) {
    if (parent.direction !== direction) continue
    const index = parent.children.findIndex((child) => child.id === id)
    const sibling = parent.children[forward ? index + 1 : index - 1]
    if (!sibling) continue
    const candidates = panes(sibling)
    return forward ? candidates[0] : candidates.at(-1)
  }
  return undefined
}

export function findNode(node: LayoutNode, id: string): LayoutNode | undefined {
  if (node.id === id) return node
  if (node.type === 'pane') return undefined
  for (const child of node.children) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

export function parentOf(root: LayoutNode, id: string): SplitNode | undefined {
  if (root.type === 'pane') return undefined
  for (const child of root.children) {
    if (child.id === id) return root
    const found = parentOf(child, id)
    if (found) return found
  }
  return undefined
}

export const zoneDirection = (zone: Exclude<DropZone, 'centre'>): SplitDirection =>
  zone === 'left' || zone === 'right' ? 'row' : 'column'
export const zoneAfter = (zone: Exclude<DropZone, 'centre'>): boolean => zone === 'right' || zone === 'bottom'

/** The smallest a node can be without clipping what its panes show, gutters included. */
export function minSize(node: LayoutNode, tabs: Record<string, Tab>): { width: number; height: number } {
  if (node.type === 'pane') {
    const widths = node.tabs.map((id) => PANE_MIN.width[tabKind(tabs[id]?.target)])
    return { width: Math.max(...widths, PANE_MIN.width.empty), height: PANE_MIN.height }
  }
  const children = node.children.map((child) => minSize(child, tabs))
  const gutters = GUTTER * (children.length - 1)
  const sum = (key: 'width' | 'height') => children.reduce((total, child) => total + child[key], 0) + gutters
  const max = (key: 'width' | 'height') => Math.max(...children.map((child) => child[key]))
  return node.direction === 'row'
    ? { width: sum('width'), height: max('height') }
    : { width: max('width'), height: sum('height') }
}

/**
 * The boundary a pane grows across toward `edge`: the nearest split along that axis where the pane
 * is not already at that edge, the index of the child holding the pane, and of the child beyond.
 */
export function boundaryToward(
  root: LayoutNode,
  paneId: string,
  edge: Edge,
): { split: SplitNode; index: number; beyond: number } | undefined {
  const direction = zoneDirection(edge)
  const step = zoneAfter(edge) ? 1 : -1
  let id = paneId
  for (let parent = parentOf(root, id); parent; id = parent.id, parent = parentOf(root, id)) {
    if (parent.direction !== direction) continue
    const index = parent.children.findIndex((child) => child.id === id)
    const beyond = index + step
    if (beyond >= 0 && beyond < parent.children.length) return { split: parent, index, beyond }
  }
  return undefined
}
