// `@ade/client/journals`: client-side delivery reliability for every Node client.
// The journals hold requests the profile daemon has not admitted; the daemon owns
// each one from admission on. Electron main and the CLI both build on these, each
// with its own storage location. Nothing here imports a UI framework or Electron.
export {
  SendJournal,
  type SendJournalExport,
  type SendJournalIdentity,
  type SendJournalImport,
  type SendJournalRecord,
} from './send-journal.js'
export { GitJournal, type GitIntent } from './git-journal.js'
export { fileOutboxStorage, openClientJournals, type ClientJournals } from './journal-file.js'
export { lockJournalDirectory, type JournalLockOptions } from './journal-lock.js'
export {
  SendPipeline,
  type SendDraft,
  type SendEntry,
  type SendIntent,
  type SendOwner,
  type SendPending,
  type SendPipelineHooks,
  type SendReconciled,
  type SendResult,
} from './send-pipeline.js'
export {
  deliverHeldSends,
  heldDirectSends,
  SendHeld,
  sendJournaled,
  socketProfileId,
  type DirectDelivery,
} from './journaled-send.js'
export {
  acknowledgeGitJournal,
  GitOperationBlocked,
  readGitJournal,
  sendGitMutation,
  type DaemonGitIntent,
  type GitJournalAcknowledged,
  type GitJournalState,
  type GitMutationOptions,
} from './git-recovery.js'
