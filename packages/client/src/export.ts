// Readable conversation export (F050): the complete retained history as JSON, read through the
// public `conversation.export` pages without holding the transcript in memory. It never
// overwrites a file, leaves no partial file behind, and refuses a history that changes while it
// reads. The header says whether a provider can still continue the conversation natively;
// readability never implies it. Each message carries whether its attachments' payloads remain.
import { randomUUID } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { decodeResponse } from '@ade/contracts'
import { requestDaemon } from './request.js'

export const EXPORT_FORMAT = 'ade-conversation-export-v1'

/** Why an export failed: the daemon's pages were inconsistent, or the file could not be written. */
export class ExportError extends Error {
  constructor(
    readonly code: 'protocol' | 'invalid_request',
    message: string,
  ) {
    super(message)
  }
}

export type ExportResult = {
  type: 'conversation_export'
  conversation_id: string
  file: string
  format: typeof EXPORT_FORMAT
  message_count: number
  boot_id: string
  revision: number
}

const PAGE = 32

export async function exportConversation(
  endpoint: string,
  conversationId: string,
  destination: string,
): Promise<ExportResult> {
  const read = async (after?: number) =>
    decodeResponse(
      'conversation.export',
      await requestDaemon(endpoint, 'conversation.export', {
        conversation_id: conversationId,
        limit: PAGE,
        ...(after === undefined ? {} : { after_sequence: after }),
      }),
    )
  const first = await read()
  if (first.conversation.id !== conversationId)
    throw new ExportError('protocol', 'Daemon returned another conversation.')
  const { boot_id: bootId, revision, history_epoch: epoch } = first
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(temporary, 'wx', 0o600)
  } catch (error) {
    throw new ExportError('invalid_request', `Cannot create export file: ${String(error)}`)
  }
  let closed = false
  let count = 0
  let page = first
  try {
    const header = {
      format: EXPORT_FORMAT,
      scope: 'conversation-history',
      message_order: 'oldest_first',
      boot_id: bootId,
      revision,
      history_epoch: epoch,
      conversation: first.conversation,
      continuity: first.continuity,
      not_included: first.not_included,
    }
    const opening = JSON.stringify(header, null, 2)
    await file.writeFile(opening.slice(0, -2) + ',\n  "messages": [\n')
    let previous = Number.NEGATIVE_INFINITY
    for (;;) {
      if (page.boot_id !== bootId || page.revision !== revision || page.history_epoch !== epoch)
        throw new ExportError('protocol', 'The conversation changed while it was exported; retry the export.')
      for (const entry of page.messages) {
        const sequence = entry.message.sequence
        if (entry.message.conversation_id !== conversationId || sequence <= previous)
          throw new ExportError('protocol', 'Daemon returned an invalid or overlapping history page; retry the export.')
        previous = sequence
        await file.writeFile(`${count ? ',\n' : ''}${JSON.stringify(entry, null, 2)}`)
        count++
      }
      if (page.next_after_sequence === null) break
      page = await read(page.next_after_sequence)
    }
    await file.writeFile('\n  ]\n}\n')
    await file.sync()
    await file.close()
    closed = true
    try {
      await link(temporary, destination)
    } catch (error) {
      throw new ExportError(
        'invalid_request',
        (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'Export destination already exists; choose a new file.'
          : `Cannot publish export file: ${String(error)}`,
      )
    }
    const directory = await open(dirname(destination), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return {
      type: 'conversation_export',
      conversation_id: conversationId,
      file: destination,
      format: EXPORT_FORMAT,
      message_count: count,
      boot_id: bootId,
      revision,
    }
  } finally {
    if (!closed) await file.close()
    await unlink(temporary).catch(() => undefined)
  }
}
