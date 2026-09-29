import { useState } from 'react'
import { useStore } from 'zustand'
import { activeWorkspace, layoutStore } from '../model/layout-store'
import { setCollapsedProjects } from '../model/layout-sync'

// Which workspace this window shows and which project rows it keeps collapsed: both live in the
// window's daemon record (`window.show_workspace`, `window.set_view_state`), so another client on
// the same window sees them. A window whose workspace is removed is moved by the daemon.

export { selectWorkspace } from '../model/layout-sync'

const NONE: string[] = []

/** The workspace this window shows, or '' before the daemon has named one. */
export const useShownWorkspace = (): string => useStore(layoutStore, (state) => activeWorkspace(state) ?? '')

/**
 * The project rows collapsed in this window, and a toggle. A toggle shows at once; the record
 * catches up a moment later.
 */
export function useCollapsedProjects(): [string[], (projectId: string) => void] {
  const saved = useStore(layoutStore, (state) => state.window?.view.collapsed_projects ?? NONE)
  const [local, setLocal] = useState<{ saved: string[]; ids: string[] } | null>(null)
  // What this window chose last, until the record changes.
  const collapsed = local && local.saved === saved ? local.ids : saved
  const toggle = (projectId: string): void => {
    const ids = collapsed.includes(projectId)
      ? collapsed.filter((other) => other !== projectId)
      : [...collapsed, projectId]
    setLocal({ saved, ids })
    void setCollapsedProjects(ids)
  }
  return [collapsed, toggle]
}
