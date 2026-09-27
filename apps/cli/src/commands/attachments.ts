import { resolve } from 'node:path'
import { call } from '@ade/client'
import { CliError, parseWords, positionals, requestIdOption, type CommandResult } from '../shared.js'

export const attachmentUsage = `  attachment import CONVERSATION_ID FILE --request-id ID
                                        Attach a regular file the daemon reads from this host;
                                        ID becomes the attachment ID
  attachment inspect CONVERSATION_ID ATTACHMENT_ID
                                        Read an attachment's metadata and digest
  attachment reclaim-preview CONVERSATION_ID ATTACHMENT_ID
                                        Report what reclaiming an unreferenced attachment would free
  attachment reclaim CONVERSATION_ID ATTACHMENT_ID GENERATION
                                        Discard its payload only at the previewed generation
`

export async function runAttachmentCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'attachment') return undefined
  if (action === 'import') {
    const parsed = parseWords(rest, ['--request-id'], [], 'attachment import')
    const [conversation_id, file] = positionals(parsed, 2, 'attachment import requires CONVERSATION_ID FILE --request-id ID')
    const request_id = requestIdOption(parsed, 'attachment import')
    // The daemon resolves nothing against the CLI's working directory, so send an absolute path.
    return call(socketPath, 'attachment.import', { conversation_id, request_id, path: resolve(file) })
  }
  if (action === 'inspect' || action === 'reclaim-preview') {
    const [conversation_id, attachment_id] = positionals(parseWords(rest, [], [], `attachment ${action}`), 2,
      `attachment ${action} requires CONVERSATION_ID ATTACHMENT_ID`)
    return action === 'inspect'
      ? call(socketPath, 'attachment.inspect', { conversation_id, attachment_id })
      : call(socketPath, 'attachment.reclaim.preview', { conversation_id, attachment_id })
  }
  if (action === 'reclaim') {
    const [conversation_id, attachment_id, expected_generation] = positionals(parseWords(rest, [], [], 'attachment reclaim'), 3,
      'attachment reclaim requires CONVERSATION_ID ATTACHMENT_ID GENERATION')
    return call(socketPath, 'attachment.reclaim.apply', { conversation_id, attachment_id, expected_generation })
  }
  throw new CliError('usage', 'Unknown attachment command. Run ade --help for usage.')
}
