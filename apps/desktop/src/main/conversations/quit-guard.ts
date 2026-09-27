import { type BrowserWindow, dialog } from 'electron'
import type { QuitGuard } from '../quit-guards'
import { drafts, flushDraft, reconcileAcceptedSend, unsafePending } from './send-pipeline'

let warnedPendingSends: string | null = null
export async function warnPendingSends(window?: BrowserWindow): Promise<void> {
  const pending = [...drafts.entries()]
    .filter(([key, entry]) => entry.send && (!window || key.startsWith(`${window.webContents.id}:`)))
    .map(([key, entry]) => `${key}:${entry.send?.requestId}`)
    .sort()
    .join('\n')
  if (!pending || pending === warnedPendingSends) return
  warnedPendingSends = pending
  if (process.env.ADE_E2E_USER_DATA_DIR) {
    console.error('Prompt delivery is unconfirmed; pending request IDs:', pending)
    return
  }
  const options = window
    ? { type: 'warning' as const, title: 'Prompt delivery is unconfirmed',
        message: 'This window is staying open until the prompt is reconciled.',
        detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' }
    : { type: 'warning' as const, title: 'Prompt delivery is unconfirmed',
        message: 'ADE is staying open until the prompt is reconciled.',
        detail: 'Reconnect the profile daemon and use Retry prompt delivery. ADE will reuse the original request ID.' }
  if (window) await dialog.showMessageBox(window, options)
  else await dialog.showMessageBox(options)
}

/** Holds the quit until every draft is saved and every accepted send is reconciled. */
export const draftQuitGuard: QuitGuard = () => {
  if (process.env.ADE_E2E_HIDE_WINDOW === '1' && process.env.ADE_E2E_TEST_CLOSE_GUARD !== '1') return null
  const owned = [...drafts.values()]
  if (!owned.some((entry) => entry.send || entry.timer || entry.savedRevision < entry.draft.revision)) return null
  return async () => {
    await Promise.allSettled(owned.filter((entry) => entry.send).map(reconcileAcceptedSend))
    if (await unsafePending(owned)) {
      await warnPendingSends()
      return false
    }
    const pending = owned.filter((entry) => !entry.send && (entry.timer || entry.savedRevision < entry.draft.revision))
    const results = await Promise.allSettled(pending.map(flushDraft))
    if (results.some((result) => result.status === 'rejected')) {
      if (process.env.ADE_E2E_USER_DATA_DIR) console.error('Draft was not saved during app quit')
      else await dialog.showMessageBox({ type: 'error', title: 'Draft was not saved',
        message: 'ADE is staying open because a draft could not be saved.',
        detail: 'Restore the profile daemon and try closing ADE again.' })
      return false
    }
    if (await unsafePending(owned)) {
      await warnPendingSends()
      return false
    }
    return true
  }
}
