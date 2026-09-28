import { useContext } from 'react'
import { useStore } from 'zustand'
import { Status, type StatusState } from '@/components/Status'
import { Meta } from '@/components/Typography'
import type { DaemonState } from '../../../state/daemon-store'
import { DaemonStoreContext } from '../../../state/hooks'

// The fixed bottom row: connection and background state. Items are status marks with short labels.

const CONNECTION: Record<DaemonState['status'], { state: StatusState; label: string }> = {
  connected: { state: 'done', label: 'Connected' },
  connecting: { state: 'running', label: 'Connecting…' },
  reconnecting: { state: 'running', label: 'Reconnecting…' },
  unavailable: { state: 'error', label: 'Daemon unavailable' },
  incompatible: { state: 'error', label: 'Daemon version mismatch' },
  unconfigured: { state: 'idle', label: 'No daemon configured' },
}

const noStore = { getState: () => ({ status: 'unconfigured' }) as DaemonState, subscribe: () => () => undefined }

function useConnection(): DaemonState['status'] {
  const store = useContext(DaemonStoreContext)
  return useStore((store ?? noStore) as never, (state: DaemonState) => state.status)
}

function StatusItem({ state, label }: { state: StatusState; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Status state={state} label={label} />
      <Meta aria-hidden>{label}</Meta>
    </span>
  )
}

export function BottomBar() {
  const connection = CONNECTION[useConnection()]
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 bg-sidebar px-3">
      <StatusItem state={connection.state} label={connection.label} />
    </footer>
  )
}
