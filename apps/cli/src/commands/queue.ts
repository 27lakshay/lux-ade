import { call } from '@ade/client'
import { CliError, effectOperationId, parseWords, positionals, requestIdOption, type CommandResult } from '../shared.js'

export const queueUsage = `  queue add CONVERSATION_ID TEXT --request-id ID
                                        Queue a prompt; ID becomes the queued prompt's ID, so
                                        reuse it only to retry the same prompt after a lost reply
  queue cancel CONVERSATION_ID REQUEST_ID
                                        Cancel a queued prompt that has not been submitted
  queue pause CONVERSATION_ID           Pause the conversation's prompt queue
  queue resume CONVERSATION_ID          Resume the conversation's prompt queue
`

export async function runQueueCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'queue') return undefined
  if (action === 'add') {
    const parsed = parseWords(rest, ['--request-id'], [], 'queue add')
    const [conversation_id, text] = positionals(parsed, 2, 'queue add requires CONVERSATION_ID TEXT --request-id ID')
    const request_id = requestIdOption(parsed, 'queue add')
    const response = await call(socketPath, 'queue.enqueue', { conversation_id, request_id, text })
    return { ...response, request_id }
  }
  if (action === 'cancel') {
    const [conversation_id, request_id] = positionals(
      parseWords(rest, [], [], 'queue cancel'),
      2,
      'queue cancel requires CONVERSATION_ID REQUEST_ID',
    )
    return call(socketPath, 'queue.cancel', { conversation_id, request_id })
  }
  if (action === 'pause' || action === 'resume') {
    const [conversation_id] = positionals(
      parseWords(rest, [], [], `queue ${action}`),
      1,
      `queue ${action} requires CONVERSATION_ID`,
    )
    return call(socketPath, 'queue.pause', {
      operation_id: effectOperationId(),
      conversation_id,
      paused: action === 'pause',
    })
  }
  throw new CliError('usage', 'Unknown queue command. Run ade --help for usage.')
}
