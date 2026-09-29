import { dailyUseCommand } from '@ade/client'
import {
  CliError,
  effectOperationId,
  namedOptions,
  required,
  requiredOperationId,
  type CommandResult,
} from '../shared.js'
import { parseWakeTime } from './wake-time.js'

export const conversationControlUsage = `  conversation controls ID               Show which steer, compact and rewind controls the provider supports now
  conversation steer ID TURN_ID TEXT --operation-id ID
                                        Add input to the running turn natively; never queues it
  conversation compact ID --operation-id ID
                                        Ask the provider to compact its context
  conversation rewind-preview ID files CHECKPOINT | ID conversation [MESSAGE_ID]
                                        Show whether a rewind may run and what it would change
  conversation rewind ID files CHECKPOINT STATE_TOKEN --operation-id ID [--confirm-overwrite]
                                        Restore the workspace files from a checkpoint
  conversation rewind ID conversation MESSAGE_ID STATE_TOKEN --operation-id ID
                                        Remove MESSAGE_ID's turn and every later one from the provider and ADE
  conversation snooze ID WHEN           Defer attention until WHEN: +30m, +2h, +1d, an ISO time
                                        with a zone, or epoch milliseconds; agent work continues
  conversation unsnooze ID              End a snooze now
  conversation snoozes                  List active snoozes, soonest first
  conversation delete ID                Delete an idle Conversation, its history, drafts and queue; stops an idle
                                        agent first. Retry a lost reply with the same --operation-id
`

/** A control that did not take effect fails the command, with the daemon's reason. */
function settled<T extends { outcome: string; reason?: string | null }>(reply: T): T {
  const reason = typeof reply.reason === 'string' ? reply.reason : 'No reason was given.'
  if (reply.outcome === 'unavailable') throw new CliError('unavailable', reason)
  if (reply.outcome === 'unknown') throw new CliError('outcome_unknown', reason)
  if (reply.outcome === 'partial') throw new CliError('not_applied', `Files were only partly restored: ${reason}`)
  return reply
}

function split(
  rest: string[],
  positional: number,
  allowed: readonly string[],
  command: string,
): { args: string[]; options: Record<string, string> } {
  if (rest.length < positional || rest.slice(0, positional).some((word) => word.startsWith('--'))) {
    throw new CliError('usage', `conversation ${command} is missing arguments. Run ade --help for usage.`)
  }
  return {
    args: rest.slice(0, positional),
    options: namedOptions(rest.slice(positional), allowed, `conversation ${command}`),
  }
}

export async function runConversationControlCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'conversation') return undefined
  if (action === 'controls') {
    const { args } = split(rest, 1, [], 'controls')
    return dailyUseCommand(socketPath, { op: 'conversation.controls', conversation_id: required(args[0], 'ID') })
  }
  if (action === 'steer') {
    const { args } = split(rest, 3, [], 'steer')
    return settled(
      await dailyUseCommand<'conversation.steer'>(socketPath, {
        op: 'conversation.steer',
        operation_id: requiredOperationId(),
        conversation_id: args[0],
        turn_id: args[1],
        text: required(args[2], 'TEXT'),
      }),
    )
  }
  if (action === 'compact') {
    const { args } = split(rest, 1, [], 'compact')
    return settled(
      await dailyUseCommand<'conversation.compact'>(socketPath, {
        op: 'conversation.compact',
        operation_id: requiredOperationId(),
        conversation_id: args[0],
      }),
    )
  }
  if (action === 'rewind-preview') {
    const scope = rest[1]
    if (scope === 'conversation' && (rest.length === 2 || rest.length === 3)) {
      return dailyUseCommand(socketPath, {
        op: 'conversation.rewind.preview',
        conversation_id: rest[0],
        scope: 'conversation',
        ...(rest[2] ? { before_message_id: rest[2] } : {}),
      })
    }
    const { args } = split(rest, 3, [], 'rewind-preview')
    if (scope !== 'files') throw new CliError('usage', 'Rewind scope must be files or conversation.')
    return dailyUseCommand(socketPath, {
      op: 'conversation.rewind.preview',
      conversation_id: args[0],
      scope: 'files',
      checkpoint_id: args[2],
    })
  }
  if (action === 'rewind') {
    const confirm = rest.filter((word) => word === '--confirm-overwrite')
    if (confirm.length > 1) throw new CliError('usage', '--confirm-overwrite may be supplied only once.')
    const words = rest.filter((word) => word !== '--confirm-overwrite')
    if (words[1] === 'conversation') {
      const positional = words.length > 2 && !words[2].startsWith('--') ? 4 : 2
      const { args } = split(words, positional, [], 'rewind')
      return settled(
        await dailyUseCommand<'conversation.rewind'>(socketPath, {
          op: 'conversation.rewind',
          operation_id: requiredOperationId(),
          conversation_id: args[0],
          scope: 'conversation',
          confirm_overwrite: false,
          ...(positional === 4 ? { before_message_id: args[2], expected_state: args[3] } : {}),
        }),
      )
    }
    const { args } = split(words, 4, [], 'rewind')
    if (args[1] !== 'files') throw new CliError('usage', 'Rewind scope must be files or conversation.')
    return settled(
      await dailyUseCommand<'conversation.rewind'>(socketPath, {
        op: 'conversation.rewind',
        operation_id: requiredOperationId(),
        conversation_id: args[0],
        scope: 'files',
        checkpoint_id: args[2],
        expected_state: args[3],
        confirm_overwrite: confirm.length === 1,
      }),
    )
  }
  if (action === 'snooze') {
    const { args } = split(rest, 2, [], 'snooze')
    if (rest.length !== 2) throw new CliError('usage', 'conversation snooze requires ID WHEN.')
    const until = parseWakeTime(args[1], Date.now())
    if (until === undefined) {
      throw new CliError('usage', 'WHEN must be +N with m, h or d, an ISO time with a zone, or epoch milliseconds.')
    }
    return dailyUseCommand(socketPath, { op: 'conversation.snooze', conversation_id: args[0], until })
  }
  if (action === 'unsnooze') {
    const { args } = split(rest, 1, [], 'unsnooze')
    return dailyUseCommand(socketPath, { op: 'conversation.unsnooze', conversation_id: args[0] })
  }
  if (action === 'snoozes') {
    if (rest.length !== 0) throw new CliError('usage', 'conversation snoozes takes no arguments.')
    return dailyUseCommand(socketPath, { op: 'conversation.snooze.list' })
  }
  if (action === 'delete') {
    const { args } = split(rest, 1, [], 'delete')
    return dailyUseCommand<'conversation.delete'>(socketPath, {
      op: 'conversation.delete',
      operation_id: effectOperationId(),
      conversation_id: args[0],
    })
  }
  return undefined
}
