import { useEffect, useRef } from 'react'
import { useDaemon } from '../../../state/hooks'
import { adoptLayout, DEFAULT_WORKSPACE, layoutStore, setActiveWorkspace } from '../model/layout-store'

// Which daemon workspace this window shows. Its layout is kept under the workspace's id
// (layout-store.ts); main is told too, since it fences review and conversation requests to the
// workspace the window shows.

export function selectWorkspace(id: string): void {
  setActiveWorkspace(id)
  void window.adeHost?.workspaces.select(id, null).catch(() => {})
}

/**
 * Keeps the window on a workspace the daemon has. Once the catalog arrives, a window still on the
 * placeholder layout moves to the first workspace, taking the layout with it; a window whose
 * workspace was removed moves to the first one left. A layout that was never a daemon workspace
 * (the benchmark's) is left alone.
 */
export function useWorkspaceSync(): void {
  const ids = useDaemon((state) => state.workspaceIds)
  const connected = useDaemon((state) => state.status === 'connected')
  const known = useRef(new Set<string>())
  useEffect(() => {
    if (!connected) return
    const { active } = layoutStore.getState()
    const lost = known.current.has(active) && !ids.includes(active)
    ids.forEach((id) => known.current.add(id))
    const first = ids[0]
    if (!first || ids.includes(active)) {
      if (ids.includes(active)) void window.adeHost?.workspaces.select(active, null).catch(() => {})
      return
    }
    if (active === DEFAULT_WORKSPACE) {
      adoptLayout(DEFAULT_WORKSPACE, first)
      selectWorkspace(first)
    } else if (lost) selectWorkspace(first)
  }, [ids, connected])
}
