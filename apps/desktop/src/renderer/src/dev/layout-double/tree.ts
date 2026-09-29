import type { Edge, LayoutNode, SplitDirection, SplitNode } from '@ade/contracts'
import { findNode, parentOf, zoneAfter, zoneDirection } from '../../features/workspace/model/layout-tree'

// The layout double's pure tree edits, the TS twin of `crates/ade-core/src/layout/tree.rs`. Each
// edit mutates an immer draft and returns the root, flattened so a split has at least two children
// and never nests a split of its own direction. Test and development only (reducer.ts says why).

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

/** Puts `node` beside `targetId`, splitting the target in two. */
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
