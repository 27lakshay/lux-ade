import {
  GUTTER,
  PANE_MIN,
  type DropZone,
  type Edge,
  type LayoutNode,
  type PaneNode,
  type SplitDirection,
  type SplitNode,
  type Tab,
} from './layout'

// The pane tree: queries and pure edits. Each edit returns a new tree, flattened so a split has at
// least two children and never nests a split of its own direction.

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

function parentOf(root: LayoutNode, id: string): SplitNode | undefined {
  if (root.type === 'pane') return undefined
  for (const child of root.children) {
    if (child.id === id) return root
    const found = parentOf(child, id)
    if (found) return found
  }
  return undefined
}

/** A split id not yet in the tree, derived from the node that caused the split. */
function splitId(root: LayoutNode, from: string): string {
  const taken = new Set<string>()
  const collect = (node: LayoutNode): void => {
    taken.add(node.id)
    if (node.type === 'split') node.children.forEach(collect)
  }
  collect(root)
  let id = `split-${from}`
  for (let n = 2; taken.has(id); n++) id = `split-${from}-${n}`
  return id
}

export const zoneDirection = (zone: Exclude<DropZone, 'centre'>): SplitDirection =>
  zone === 'left' || zone === 'right' ? 'row' : 'column'
export const zoneAfter = (zone: Exclude<DropZone, 'centre'>): boolean => zone === 'right' || zone === 'bottom'

/** Puts `node` beside `targetId`, splitting the target in two. Mutates the draft; returns the root. */
export function insertBeside(
  root: LayoutNode,
  targetId: string,
  node: LayoutNode,
  direction: SplitDirection,
  after: boolean,
): LayoutNode {
  const parent = parentOf(root, targetId)
  if (parent && parent.direction === direction) {
    const index = parent.children.findIndex((child) => child.id === targetId)
    const half = parent.sizes[index]! / 2
    parent.sizes[index] = half
    const at = after ? index + 1 : index
    parent.children.splice(at, 0, node)
    parent.sizes.splice(at, 0, half)
    return root
  }
  const target = findNode(root, targetId)!
  const split: SplitNode = {
    type: 'split',
    id: splitId(root, node.id),
    direction,
    children: after ? [target, node] : [node, target],
    sizes: [50, 50],
  }
  if (!parent) return split
  const index = parent.children.findIndex((child) => child.id === targetId)
  parent.children[index] = split
  return root
}

/** Takes a node out of the tree, giving its space to a neighbour and collapsing one-child splits. */
export function removeNode(root: LayoutNode, id: string): LayoutNode {
  const parent = parentOf(root, id)
  if (!parent) return root
  const index = parent.children.findIndex((child) => child.id === id)
  const [freed] = parent.sizes.splice(index, 1)
  parent.children.splice(index, 1)
  const neighbour = index > 0 ? index - 1 : 0
  parent.sizes[neighbour] = (parent.sizes[neighbour] ?? 0) + (freed ?? 0)
  if (parent.children.length > 1) return root
  return replaceNode(root, parent.id, parent.children[0]!)
}

/** Replaces a node, flattening a split into a parent split of the same direction. */
function replaceNode(root: LayoutNode, id: string, replacement: LayoutNode): LayoutNode {
  const parent = parentOf(root, id)
  if (!parent) return replacement
  const index = parent.children.findIndex((child) => child.id === id)
  if (replacement.type === 'split' && replacement.direction === parent.direction) {
    const share = parent.sizes[index]!
    parent.children.splice(index, 1, ...replacement.children)
    parent.sizes.splice(index, 1, ...replacement.sizes.map((size) => (size * share) / 100))
  } else {
    parent.children[index] = replacement
  }
  return root
}

/** Exchanges two nodes' places in the tree; each place keeps its size. */
export function swapNodes(root: LayoutNode, a: string, b: string): LayoutNode {
  const nodeA = findNode(root, a)!
  const nodeB = findNode(root, b)!
  const parentA = parentOf(root, a)
  const parentB = parentOf(root, b)
  if (!parentA || !parentB) return root
  const indexA = parentA.children.findIndex((child) => child.id === a)
  const indexB = parentB.children.findIndex((child) => child.id === b)
  parentA.children[indexA] = nodeB
  parentB.children[indexB] = nodeA
  return root
}

/** Puts `node` along an outer edge of the whole centre: a full-height column or full-width row. */
export function dock(root: LayoutNode, node: LayoutNode, edge: Edge): LayoutNode {
  const direction = zoneDirection(edge)
  const after = zoneAfter(edge)
  if (root.type === 'split' && root.direction === direction) {
    const share = 100 / (root.children.length + 1)
    root.sizes = root.sizes.map((size) => (size * (100 - share)) / 100)
    if (after) {
      root.children.push(node)
      root.sizes.push(share)
    } else {
      root.children.unshift(node)
      root.sizes.unshift(share)
    }
    return root
  }
  return {
    type: 'split',
    id: splitId(root, node.id),
    direction,
    children: after ? [root, node] : [node, root],
    sizes: [50, 50],
  }
}

/** The smallest a node can be without clipping what its panes show, gutters included. */
export function minSize(node: LayoutNode, tabs: Record<string, Tab>): { width: number; height: number } {
  if (node.type === 'pane') {
    const widths = node.tabs.map((id) => PANE_MIN.width[tabs[id]?.kind ?? 'conversation'])
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
