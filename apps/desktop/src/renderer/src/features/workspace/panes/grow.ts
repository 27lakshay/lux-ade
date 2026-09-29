import { announce } from '@atlaskit/pragmatic-drag-and-drop-live-region'
import { GUTTER, type Edge } from '../model/layout'
import { dispatch, layoutNow } from '../model/layout-store'
import { boundaryToward, minSize, panes } from '../model/layout-tree'

// Resizing from the keyboard without reaching for a gutter: the focused pane grows toward an edge,
// taking room from the pane beyond, never past that pane's minimum. The split's saved sizes change
// and its panels follow them (PaneGrid).

const STEP = 32

/** Grows the focused pane toward `edge` by a step (32px), or a tenth of its split when `big`. */
export function growFocusedPane(edge: Edge, big: boolean): void {
  const layout = layoutNow()
  const found = boundaryToward(layout.root, layout.focused_pane, edge)
  const element = found && document.getElementById(found.split.id)
  if (!found || !element) {
    announce('This pane already reaches that edge')
    return
  }
  const { split, index, beyond } = found
  const row = split.direction === 'row'
  const rect = element.getBoundingClientRect()
  const space = (row ? rect.width : rect.height) - GUTTER * (split.children.length - 1)
  const percent = (pixels: number): number => (pixels / space) * 100
  const floor = minSize(split.children[beyond]!, layout.tabs)
  const room = split.sizes[beyond]! - percent(row ? floor.width : floor.height)
  const delta = Math.min(room, big ? 10 : percent(STEP))
  if (delta <= 0.01) {
    announce('No room to grow this pane further that way')
    return
  }
  const sizes = split.sizes.map((size, i) => (i === index ? size + delta : i === beyond ? size - delta : size))
  void dispatch({ type: 'set_split_sizes', split_id: split.id, sizes })
  const number = panes(layout.root).findIndex((pane) => pane.id === layout.focused_pane) + 1
  const pixels = Math.round(((split.sizes[index]! + delta) / 100) * space)
  announce(`Pane ${number} is ${pixels} pixels ${row ? 'wide' : 'tall'}`)
}
