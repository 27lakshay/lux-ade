import type { Window } from '@ade/contracts'
import { toast } from '@/components/ui/toast'
import { hostErrorMessage } from '@/lib/host-error'
import type { LayoutsBridge } from '../../../../../shared/bridge/layouts'
import type { AdeHost } from '../../../../../shared/bridge'
import type { DaemonStore } from '../../../state/daemon-store'
import type { LayoutRecord } from './layout'
import { acceptLayout, activeWorkspace, keptWorkspaces, layoutStore, setLayoutBridge, setRefetch } from './layout-store'

// Keeps this window's record and layouts current from the daemon. Layout records arrive in
// `layout_changed` frames and in command replies; the catalog's `Window.layouts` names each layout's
// latest revision, so a layout missed while disconnected is read again with `layout.get` (the
// resubscribe rule on `Window.layouts`). The window record itself comes from the catalog only.

/** What the store is fed from: main's bridge and the daemon's catalog and feed, or a fake daemon. */
export interface LayoutConnection {
  bridge: LayoutsBridge
  /** Every window the daemon lists, whenever they change, and a key that changes on a reconnect. */
  windows(listener: (windows: Record<string, Window>, session: string) => void): () => void
  /** The daemon's feed frames. */
  frames(listener: (frame: { type: string; [key: string]: unknown }) => void): () => void
}

/** The app's connection: main's layout bridge, the catalog in the daemon store, the stream bridge's feed. */
export function hostConnection(host: Pick<AdeHost, 'layouts' | 'conversations'>, store: DaemonStore): LayoutConnection {
  return {
    bridge: host.layouts,
    windows: (listener) => {
      const send = (): void => {
        const { windows, bootId, status } = store.getState()
        listener(windows, `${bootId}:${status}`)
      }
      send()
      return store.subscribe(send)
    },
    frames: (listener) => host.conversations.onFeedFrame((frame) => listener(frame as never)),
  }
}

let connection: LayoutConnection | null = null
const inFlight = new Map<string, Promise<void>>()

async function fetchLayout(workspaceId: string): Promise<void> {
  const running = inFlight.get(workspaceId)
  if (running) return running
  const windowId = layoutStore.getState().windowId
  const bridge = connection?.bridge
  if (!bridge || !windowId) return
  const request = bridge
    .get(workspaceId)
    .then((record) => {
      if (layoutStore.getState().windowId === windowId) acceptLayout(record)
    })
    .catch((error: unknown) => console.warn(`Could not read the layout of ${workspaceId}`, error))
    .finally(() => inFlight.delete(workspaceId))
  inFlight.set(workspaceId, request)
  return request
}

/** Reads each kept layout this window lacks or holds at an older revision than the daemon names. */
function refresh(reconnected: boolean): void {
  const state = layoutStore.getState()
  const window = state.window
  if (!window) return
  for (const workspaceId of keptWorkspaces(state)) {
    const held = state.records[workspaceId]
    const latest = window.layouts[workspaceId] ?? 0
    if (!held || held.revision < latest || (reconnected && held.revision !== latest)) void fetchLayout(workspaceId)
  }
}

function setWindowId(windowId: string | null): void {
  if (layoutStore.getState().windowId === windowId) return
  inFlight.clear()
  layoutStore.setState({ windowId, window: null, records: {}, pending: null })
}

/** Starts feeding the store from `next`; returns the function that stops it. */
export function startLayoutSync(next: LayoutConnection): () => void {
  connection = next
  setLayoutBridge(next.bridge)
  setRefetch(fetchLayout)
  let session: string | null = null
  let windows: Record<string, Window> = {}
  const follow = (): void => {
    const state = layoutStore.getState()
    const window = (state.windowId && windows[state.windowId]) || null
    const pending = state.pending && window?.workspace_id !== state.pending ? state.pending : null
    if (window !== state.window || pending !== state.pending) layoutStore.setState({ window, pending })
  }
  const stops = [
    next.windows((listed, key) => {
      windows = listed
      follow()
      const reconnected = session !== null && session !== key
      session = key
      refresh(reconnected)
    }),
    next.frames((frame) => {
      if (frame.type === 'layout_changed') acceptLayout(frame.layout as LayoutRecord)
      else if (frame.type === 'layout_removed' && frame.window_id === layoutStore.getState().windowId) {
        const { [frame.workspace_id as string]: _removed, ...records } = layoutStore.getState().records
        layoutStore.setState({ records })
        refresh(false)
      }
    }),
    next.bridge.onWindowId((windowId) => {
      setWindowId(windowId)
      follow()
      refresh(false)
    }),
  ]
  void next.bridge.windowId().then((windowId) => {
    if (connection !== next || windowId === null) return
    setWindowId(windowId)
    follow()
    refresh(false)
  })
  return () => {
    for (const stop of stops) stop()
    if (connection === next) {
      connection = null
      setLayoutBridge(null)
    }
  }
}

/** Shows another workspace in this window: at once here, and in the daemon's record, whose reply carries its layout. */
export function selectWorkspace(workspaceId: string): void {
  const bridge = connection?.bridge
  if (!bridge || activeWorkspace(layoutStore.getState()) === workspaceId) return
  const windowId = layoutStore.getState().windowId
  layoutStore.setState({ pending: workspaceId })
  bridge.showWorkspace(workspaceId).then(
    ({ layout }) => {
      if (layoutStore.getState().windowId === windowId) acceptLayout(layout)
      const state = layoutStore.getState()
      if (state.pending === workspaceId && state.window?.workspace_id === workspaceId)
        layoutStore.setState({ pending: null })
    },
    (error: unknown) => {
      if (layoutStore.getState().pending === workspaceId) layoutStore.setState({ pending: null })
      toast.add({ type: 'error', title: 'Could not show the workspace', description: hostErrorMessage(error) })
    },
  )
}

/** The project rows the navigator shows collapsed in this window, kept in its record. */
export async function setCollapsedProjects(projectIds: string[]): Promise<void> {
  try {
    await connection?.bridge.setCollapsedProjects(projectIds)
  } catch (error) {
    toast.add({ type: 'error', title: 'Could not save the navigator', description: hostErrorMessage(error) })
  }
}
