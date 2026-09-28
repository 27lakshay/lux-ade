import { createContext, useContext } from 'react'

/** Whether the pane is collapsed, which way, and how to open it again. */
export const PaneCollapse = createContext<{ collapsed: 'row' | 'column' | null; expand: () => void }>({
  collapsed: null,
  expand: () => {},
})
export const usePaneCollapse = () => useContext(PaneCollapse)
