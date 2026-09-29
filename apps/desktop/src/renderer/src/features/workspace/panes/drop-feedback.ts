import { announce } from '@atlaskit/pragmatic-drag-and-drop-live-region'
import { create } from 'zustand'
import type { Layout, LayoutRecord } from '../model/layout'
import { activeWorkspace, layoutStore } from '../model/layout-store'
import { findPane, paneOfTab, panes } from '../model/layout-tree'
import { tabTitle } from '../model/tab-title'

// What a drop tells the person: a sentence for screen readers, and an outline that slides from the
// highlight they dropped on to the pane the drop produced (DropSettle).

type Box = { left: number; top: number; width: number; height: number }
export const useSettle = create<{ from: Box; to: Box; key: number } | null>(() => null)

const box = (element: Element | null): Box | null => {
  if (!element) return null
  const { left, top, width, height } = element.getBoundingClientRect()
  return width > 0 && height > 0 ? { left, top, width, height } : null
}

/** "pane 2 of 3", in reading order: the name screen readers hear for a pane. */
const paneName = (layout: Layout, paneId: string): string => {
  const all = panes(layout.root)
  return `pane ${all.findIndex((pane) => pane.id === paneId) + 1} of ${all.length}`
}

/**
 * Sends a drop's change, then, once the daemon has made it, announces what it did and settles the
 * outline onto the focused pane (every drop focuses the pane it lands in). `from` is where the
 * highlight was.
 */
export async function afterDrop(
  change: () => Promise<LayoutRecord | null>,
  describe: (layout: Layout) => string | null,
  settle = true,
): Promise<void> {
  const from = box(document.querySelector('[data-drop-zone], [data-dock-region]'))
  const state = layoutStore.getState()
  const before = state.records[activeWorkspace(state) ?? '']?.revision
  const record = await change()
  // Refused, or a drop that changed nothing (the daemon keeps the revision).
  if (!record || record.revision === before) return
  const after = record.layout
  const message = describe(after)
  if (message) announce(message)
  if (!settle || !from) return
  // Wait for the new arrangement to lay out before measuring where the pane ended up.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const to = box(document.querySelector(`[data-pane-id="${after.focused_pane}"]`))
      if (to) useSettle.setState({ from, to, key: performance.now() })
    }),
  )
}

export const describeTab = (layout: Layout, tabId: string, verb = 'Moved'): string => {
  const pane = paneOfTab(layout.root, tabId)
  const title = tabTitle(layout, tabId)
  if (!pane) return `${verb} ${title}`
  return `${verb} ${title} to position ${pane.tabs.indexOf(tabId) + 1} of ${pane.tabs.length} in ${paneName(layout, pane.id)}`
}

export const describePane = (layout: Layout, paneId: string, verb: string): string =>
  findPane(layout.root, paneId) ? `${verb} ${paneName(layout, paneId)}` : verb
