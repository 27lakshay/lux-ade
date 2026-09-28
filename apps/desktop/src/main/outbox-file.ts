// Where Electron main keeps its client journals: the SDK's file storage, in the
// app's user data folder (`pending-sends-v1.json` and `git-intents-v1.json`).
// The journals themselves, and the rules for them, live in `@ade/client/journals`.
import { app } from 'electron'
import { openClientJournals, type ClientJournals } from '@ade/client/journals'

export function openDesktopJournals(): Promise<ClientJournals> {
  return openClientJournals(app.getPath('userData'))
}
