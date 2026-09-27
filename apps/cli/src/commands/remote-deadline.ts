// How long the CLI waits for each `remote.*` reply. The daemon runs ssh
// inside these requests, so the client must outlast the daemon's own ssh
// deadlines (crates/ade-daemon/src/sessions/remote.rs) or it reports a
// running start as unknown and invites a second start.
const MARGIN_MS = 30_000
/** ssh -G (10 s) then ssh-keyscan (30 s). */
const ADD_BUDGET_MS = 40_000
/** One probe over ssh. */
const PROBE_BUDGET_MS = 45_000
/** A probe, then the start script (60 s). */
const START_BUDGET_MS = PROBE_BUDGET_MS + 60_000
const DEFAULT_MS = 30_000

export function remoteDeadlineMs(op: string): number {
  switch (op) {
    case 'remote.host.add': return ADD_BUDGET_MS + MARGIN_MS
    case 'remote.host.probe': return PROBE_BUDGET_MS + MARGIN_MS
    case 'remote.host.start': return START_BUDGET_MS + MARGIN_MS
    default: return DEFAULT_MS
  }
}
