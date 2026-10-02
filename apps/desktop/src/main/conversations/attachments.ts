import { BrowserWindow, dialog, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { dailyUseCommand } from '@ade/client'
import type { Attachment } from '@ade/contracts'

/**
 * Lets the person choose files and imports each through the daemon, which checks its type and
 * size and stores it. Returns nothing when the dialog is cancelled. A refused file refuses the
 * whole choice, so the draft gains no partial set.
 */
export async function chooseAttachments(
  sender: WebContents,
  endpoint: string,
  conversationId: string,
): Promise<Attachment[]> {
  const parent = BrowserWindow.fromWebContents(sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Attach files',
    properties: ['openFile', 'multiSelections'],
    buttonLabel: 'Attach',
  }
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (result.canceled) return []
  const imported: Attachment[] = []
  for (const path of result.filePaths) {
    const reply = await dailyUseCommand(endpoint, {
      op: 'attachment.import',
      conversation_id: conversationId,
      request_id: randomUUID(),
      path,
    })
    imported.push(reply.attachment)
  }
  return imported
}
