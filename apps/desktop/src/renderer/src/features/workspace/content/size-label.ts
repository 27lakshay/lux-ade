import { create } from 'zustand'

// What a tab's content says about its own size while a pane is being resized: a terminal reports
// "120 × 40" (columns × rows) as its grid refits. Panes show the active tab's label only while a
// resize is under way.

export const useSizeLabels = create<{ labels: Record<string, string>; resizing: boolean }>(() => ({
  labels: {},
  resizing: false,
}))

/** Content calls this as its size changes; null removes the label. */
export function setSizeLabel(tabId: string, label: string | null): void {
  useSizeLabels.setState((state) => {
    const labels = { ...state.labels }
    if (label === null) delete labels[tabId]
    else labels[tabId] = label
    return { labels }
  })
}

let settle: ReturnType<typeof setTimeout> | undefined
/**
 * Called as any split or sidebar changes size; counts only while a handle is being dragged, so
 * startup, collapses and swaps show no readout. The readouts hide shortly after the drag stops.
 */
export function noteResizing(): void {
  if (!document.querySelector('[data-separator=active]')) return
  if (!useSizeLabels.getState().resizing) useSizeLabels.setState({ resizing: true })
  clearTimeout(settle)
  settle = setTimeout(() => useSizeLabels.setState({ resizing: false }), 600)
}
