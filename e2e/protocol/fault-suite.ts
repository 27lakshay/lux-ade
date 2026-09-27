// The fault conformance suite (F140): every protocol E2E test that injects a
// fault, across all areas. `pnpm test:e2e:protocol:faults` runs the tests
// whose file path or title names one of these faults, carries the `@fault`
// tag, or is named in `faultClasses` below. Name the fault in a new test's
// title, or add `@fault`, and the suite picks it up; no list of files to keep
// in step.
export const faultVocabulary = [
  // Process faults: crashes, kills, restarts, hangs.
  'crash', 'kill', 'restart', 'dies', 'died', 'dead', 'frozen', 'hang', 'exits during',
  // Lost and uncertain outcomes.
  'lost', 'unknown', 'interrupt', 'reconcil', 'quarantin', 'orphan', 'recover', 'survive',
  // Duplicate and conflicting requests.
  'duplicate', 'conflict', 'replay', 'retry', 'retried', 'twice', 'same operation ID', 'same request ID', 'in flight',
  // Races, theft and revocation of a resource.
  'race', 'racing', 'foreign', 'taken', 'revok', 'withdr', 'evict', 'stale',
  // Broken inputs and targets.
  'corrupt', 'disconnect', 'offline', 'fault', 'fail',
]

/** One test, named by its file under `e2e/protocol/` and a part of its title. */
export type FaultTest = { file: string; title: string }

/**
 * One fault of a class: the tests that inject it, or `gap` naming why no
 * protocol E2E test can inject it yet. A fault with both is covered in part.
 */
export type Fault = { fault: string; tests: FaultTest[]; gap?: string }

export type FaultClass = { id: number; name: string; faults: Fault[] }

const t = (file: string, title: string): FaultTest => ({ file, title })

/**
 * The required fault scenarios of architecture section 12, one entry per
 * numbered class, each fault mapped to the tests that inject it. The spec
 * `load/fault-classes.spec.ts` checks that every named test exists and runs in
 * this suite, and reports each gap as a `fixme`.
 */
export const faultClasses: FaultClass[] = [
  { id: 1, name: 'Physical resources shared across profiles', faults: [
    { fault: 'competing profiles acquire the same checkout', tests: [
      t('resources/host-resources.spec.ts', 'two profiles reserving the same unborn path'),
      t('profiles/isolation.spec.ts', 'a checkout one profile works in stays a visible conflict')] },
    { fault: 'deletion races with launch', tests: [
      t('resources/host-resources.spec.ts', 'a launch racing a removal in another profile')] },
    { fault: 'paths are replaced', tests: [
      t('reliability-c/resources.spec.ts', 'a checkout moved away keeps its claim')] },
    { fault: 'registry migration while a runtime remains live', tests: [
      t('reliability-c/resources.spec.ts', 'a registry migrated to a newer format under a live owner')] },
    { fault: 'registry corruption while a runtime remains live', tests: [
      t('reliability-c/resources.spec.ts', 'a registry corrupted under a live owner'),
      t('resources/host-resources.spec.ts', 'a lost or unreadable registry blocks lifecycle commands')] },
  ] },
  { id: 2, name: 'Operation phases, repeats and fencing', faults: [
    { fault: 'crash between every operation phase', tests: [
      t('reliability-a/receipts.spec.ts', 'with a lost reply and a daemon crash at once runs once'),
      t('reliability-a/receipts.spec.ts', 'with a lost reply and a daemon crash after the effect runs once'),
      t('reliability-a/receipts.spec.ts', 'dispatched to a Git worker when the daemon crashes is reported unknown'),
      t('conversations2/compact.spec.ts', 'a daemon crash between dispatch and the provider acknowledgement')] },
    { fault: 'repeat the same request', tests: [
      t('reliability-a/receipts.spec.ts', 'replays one ID and refuses it for another payload'),
      t('conversations/send-queue.spec.ts', 'agent.send with the same request ID admits one turn')] },
    { fault: 'change its payload', tests: [
      t('conversations/outbox.spec.ts', 'send intents refuse a different payload or owner under the same request ID'),
      t('orchestration/parity.spec.ts', 'a changed retry conflicts')] },
    { fault: 'deliver old callbacks', tests: [
      t('reliability-a/cancel-fencing.spec.ts', 'a late provider reply to a finished turn'),
      t('terminals/ownership.spec.ts', 'input and resize naming another incarnation change nothing')] },
    { fault: 'cancel while a new turn arrives', tests: [
      t('reliability-a/cancel-fencing.spec.ts', 'a cancel racing the admission of the next turn')] },
    { fault: 'cancel while a wake arrives', tests: [
      t('load/fault-gaps.spec.ts', 'a cancel sent as a snooze falls due')] },
  ] },
  { id: 3, name: 'Saturation with stop capacity retained', faults: [
    { fault: 'saturate receipts', tests: [
      t('recovery/receipt-saturation.spec.ts', 'cancel is admitted and reaches the provider while ordinary command receipts are saturated')] },
    { fault: 'saturate streams', tests: [
      t('reliability-b/output-limit.spec.ts', 'terminal output past the replay bound'),
      t('reliability-a/overload.spec.ts', 'an output flood and a burst of ordinary commands')] },
    { fault: 'slow clients', tests: [
      t('reliability-b/slow-subscriber.spec.ts', 'a feed client that stops reading is evicted'),
      t('reliability-b/slow-subscriber.spec.ts', 'a terminal viewer that stops reading is cut off'),
      t('ops/diagnostics.spec.ts', 'a subscriber that stops reading is evicted')] },
    { fault: 'saturate storage', tests: [
      t('reliability-a/overload.spec.ts', 'with the data volume full')],
    gap: 'The full-volume test mounts a scratch volume with hdiutil, so it runs only with ADE_E2E_SYSTEM=1 and skips otherwise.' },
    { fault: 'saturate the runtime spool', tests: [
      t('recovery/replay-overflow.spec.ts', 'replay overflow while the daemon is away')] },
    { fault: 'report actual execution state under saturation', tests: [
      t('recovery/replay-overflow.spec.ts', 'reported as degraded output, not as an exit'),
      t('reliability-b/output-limit.spec.ts', 'reported as incomplete, not as an exit')] },
  ] },
  { id: 4, name: 'Projections, cursors and late pages', faults: [
    { fault: 'interrupt projection or cursor persistence', tests: [
      t('reliability-b/consistent-view.spec.ts', 'a kept activity cursor catches up exactly after a restart'),
      t('catalogs/history.spec.ts', 'catches up after a daemon kill without losing or duplicating indexed messages'),
      t('orchestration2/activity.spec.ts', 'activity cursors stay valid across a restart and a crash')] },
    { fault: 'expire a cursor', tests: [
      t('files-git/browse.spec.ts', 'changed paths invalidate cursors, a daemon restart drops them')] },
    { fault: 'late pages after a rewind', tests: [
      t('restarts/stale-rewind.spec.ts', 'an older page and a search cursor read before a rewind cannot resurrect'),
      t('restarts/stale-rewind.spec.ts', 'a snapshot delayed across a rewind never shows the removed turns as current')] },
    { fault: 'late pages after a deletion', tests: [
      t('restarts/stale-rewind.spec.ts', 'a result delayed across a conversation delete cannot resurrect it'),
      t('conversation-delete/delete.spec.ts', 'a deletion survives a daemon kill'),
      t('catalogs/history.spec.ts', 'a deleted conversation disappears from search results')] },
    { fault: 'late pages after a profile switch', tests: [
      t('reliability-b/stale-results.spec.ts', 'a profile switch drops the old profile late snapshot'),
      t('reliability-b/stale-results.spec.ts', 'late pages and cursors from another context')] },
    { fault: 'late pages after a restore', tests: [
      t('backup/history.spec.ts', 'expires source cursors')] },
    { fault: 'late pages after a new database epoch', tests: [
      t('reliability-b/consistent-view.spec.ts', 'a search cursor from an old index epoch expires')] },
  ] },
  { id: 5, name: 'Credentials, provider executables and adapter state', faults: [
    { fault: 'refresh credentials concurrently', tests: [
      t('load/fault-gaps.spec.ts', 'concurrent verifications of one account converge')] },
    { fault: 'log out during a refresh', tests: [
      t('load/fault-gaps.spec.ts', 'a sign-out or a disable racing a verification')] },
    { fault: 'replace an external provider CLI', tests: [
      t('providers/readiness.spec.ts', 'an external uninstall and an incompatible update')] },
    { fault: 'resume with incompatible adapter state', tests: [
      t('adapters/plugin-providers.spec.ts', 'a Conversation stays on the plugin version it started on'),
      t('adapters/plugin-provider-registry.spec.ts', 'a refused uninstall releases no lease')] },
    { fault: 'resume with incompatible account state', tests: [
      t('providers/account-switch.spec.ts', 'stale fences, unverified, disabled and foreign targets are refused')] },
  ] },
  { id: 6, name: 'Plugins during active work', faults: [
    { fault: 'reload a plugin during active work', tests: [
      t('reliability-c/plugin-update.spec.ts', 'a provider Conversation mid-turn finishes on the old version'),
      t('plugins/dev-reload.spec.ts', 'a broken reload leaves the current generation serving')] },
    { fault: 'finish old activation cleanup late', tests: [
      t('reliability-c/plugin-update.spec.ts', 'late cleanup keeps the new commands')] },
    { fault: 'migrate data with an old worker alive', tests: [
      t('reliability-c/plugin-update.spec.ts', 'a provider Conversation mid-turn finishes on the old version')] },
    { fault: 'freeze a plugin and recover it', tests: [
      t('devplug/plugin-recovery.spec.ts', 'a frozen host is reported unresponsive and replaced by a restart')],
    gap: 'A frozen UI plugin recovered from Electron main needs Electron E2E, which is paused until the UI phase.' },
  ] },
  { id: 7, name: 'Process trees and identifiers', faults: [
    { fault: 'reparent or escape descendants', tests: [
      t('recovery/descendants.spec.ts', 'the orphaning tree, which ignores TERM'),
      t('recovery/descendants.spec.ts', 'a script tree that survives a runtime kill is quarantined'),
      t('reliability-b/uncertainty.spec.ts', 'a provider descendant that left its group before a runtime crash')] },
    { fault: 'ignore termination', tests: [
      t('recovery/descendants.spec.ts', 'the stubborn tree, which ignores TERM'),
      t('services/faults.spec.ts', 'a service that ignores SIGTERM is escalated')] },
    { fault: 'reuse identifiers', tests: [
      t('reliability-b/uncertainty.spec.ts', 'a recorded PID now held by an unrelated process is read as gone'),
      t('terminals/ownership.spec.ts', 'a runtime crash starts a new incarnation and fences the old one')] },
    { fault: 'quarantine rather than infer a clean exit', tests: [
      t('recovery/runtime-crash.spec.ts', 'a quarantined provider tree keeps its lease'),
      t('services/recovery.spec.ts', 'a service left running by a crashed runtime is quarantined')] },
  ] },
  { id: 8, name: 'Disconnection without substitution', faults: [
    { fault: 'disconnect a remote host', tests: [
      t('remote/transport.spec.ts', 'link loss during a turn reports unknown'),
      t('remote2/stability.spec.ts', 'a disconnected and then revoked host keeps its work')] },
    { fault: 'disconnect a browser owner', tests: [
      t('load/fault-gaps.spec.ts', 'a browser owner that disconnects')] },
    { fault: 'change focus', tests: [
      t('remote2/stability.spec.ts', 'while local focus moves'),
      t('devplug/device-input.spec.ts', 'unauthorized, offline and disconnected devices refuse input without touching another device')] },
    { fault: 'revoke pairing', tests: [
      t('remote/pairing.spec.ts', 'the remote daemon rejects a connection that presents a revoked pairing'),
      t('remote2/revocation.spec.ts', 'refuses a revoked pairing even when asked to grant it again')] },
    { fault: 'no silent host, account or browser substitution', tests: [
      t('remote2/stability.spec.ts', 'nothing falls back to this Mac'),
      t('remote2/hosts.spec.ts', 'keep their own feeds, cursors and provider accounts, and fail over nothing'),
      t('load/fault-gaps.spec.ts', 'never replaced by another owner')] },
  ] },
  { id: 9, name: 'Backup, migration and compatibility', faults: [
    { fault: 'back up and restore with blobs and plugin records', tests: [
      t('backup/restore.spec.ts', 'backs up a live profile during writes and restores conversations, attachments, plugins'),
      t('backup/faults.spec.ts', 'a backup killed part-way publishes nothing')] },
    { fault: 'fail migrations', tests: [
      t('backup/restore.spec.ts', 'refuses two behind without creating the target'),
      t('backup/corrupt.spec.ts', 'refuses every damaged or unsupported bundle')] },
    { fault: 'reconnect an older client', tests: [
      t('load/fault-gaps.spec.ts', 'a client refuses a daemon of another application protocol')] },
    { fault: 'reconnect an older runtime', tests: [
      t('load/fault-gaps.spec.ts', 'a daemon of an older runtime protocol cannot claim the live runtime')] },
  ] },
]

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const classTitles = faultClasses.flatMap((entry) => entry.faults.flatMap((fault) => fault.tests.map((test) => test.title)))

/** The load run (`e2e/protocol/load/load.spec.ts`). It measures latency, so it runs alone, outside the fault suite. */
export const loadRun = /@load\b/

/** Matches a test's full title (file path, describes and title) when it belongs to the fault suite. */
export const faultSuite = new RegExp(['@fault', ...faultVocabulary, ...classTitles].map((word, index) =>
  index === 0 ? word : escape(word)).join('|'), 'i')
