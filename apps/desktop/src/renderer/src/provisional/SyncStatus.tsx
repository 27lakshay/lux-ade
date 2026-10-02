import type { ProjectionStatus } from '@ade/client/sync'
import { Meta } from '@/components/Typography'
import { useDaemon } from '../state/hooks'

const REPLAY: Record<ProjectionStatus, string> = {
  loading: 'loading history',
  stale: 'replaying history after a gap',
  degraded: 'history incomplete',
  current: 'history replayed',
  deleted: 'conversation deleted',
}

/**
 * Three separate facts about a conversation view: whether the daemon feed is connected, whether
 * the view's history replay is complete, and which daemon revision is on screen. Being connected
 * never implies the view has caught up, and a view kept while reconnecting says it may be old.
 */
export function SyncStatus({ replay, revision }: { replay: ProjectionStatus; revision: number | null }) {
  const connection = useDaemon((state) => state.status)
  const detail = useDaemon((state) => state.detail)
  const connected = connection === 'connected'
  const shown = revision === null ? 'nothing loaded yet' : `showing revision ${revision}`
  const text = connected
    ? `Connected · ${REPLAY[replay]} · ${shown}`
    : `${detail || 'Not connected to the daemon'} · ${shown}, which may be out of date`
  return (
    <Meta
      aria-label="Sync status"
      data-connection={connection}
      data-replay={replay}
      data-display-revision={revision ?? ''}
      data-caught-up={connected && replay === 'current' ? 'true' : 'false'}
    >
      {text}
    </Meta>
  )
}
