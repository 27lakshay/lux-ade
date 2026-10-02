import { randomUUID } from 'node:crypto'
import {
  call,
  DaemonRequestError,
  decodeDailyUseResponse,
  requestDaemon,
  type DailyUseOperation,
  type DailyUseRequest,
  type DailyUseResponse,
} from '@ade/client'
import { deliverHeldSends, heldDirectSends, SendHeld, sendJournaled } from '@ade/client/journals'
import { exportConversation as exportReadable, ExportError } from '@ade/client/export'
import {
  boundedInteger,
  catalog,
  CliError,
  jsonObject,
  effectOperationId,
  parseWords,
  positionals,
  required,
  withJournals,
  type CommandResult,
  type ErrorCode,
} from '../shared.js'

const heldCodes: ReadonlySet<string> = new Set<ErrorCode>(['unavailable', 'timeout', 'protocol', 'outcome_unknown'])

/**
 * Runs a journaled request, turning the journal's own refusals into CLI errors. A
 * daemon error passes through unchanged; a held prompt keeps the failure's code.
 * A record the journal refuses is `invalid_request`, one another prompt owns is
 * `conflict`, and a journal that cannot be read or written is a local failure.
 */
export async function journalFailure<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof SendHeld) {
      throw new CliError(heldCodes.has(error.code) ? (error.code as ErrorCode) : 'outcome_unknown', error.message)
    }
    if (error instanceof DaemonRequestError || error instanceof CliError || !(error instanceof Error)) throw error
    const code: ErrorCode = error.message.startsWith('Invalid')
      ? 'invalid_request'
      : /awaiting delivery|owns this|is held|needs reconciliation|belongs to another/.test(error.message)
        ? 'conflict'
        : 'protocol'
    throw new CliError(code, error.message)
  }
}

/** A typed request body: the operation's contract without its `op`. */
type Fields<O extends DailyUseOperation> = Omit<DailyUseRequest<O>, 'op'>

/** Check a daemon reply against its contract; a mismatch is a protocol error. */
function decodeReply<O extends DailyUseOperation>(op: O, response: unknown): DailyUseResponse<O> {
  try {
    return decodeDailyUseResponse(op, response)
  } catch (error) {
    throw new CliError('protocol', `Daemon ${op} reply failed its contract: ${String(error)}`)
  }
}

export const conversationUsage = `  conversation list [WORKSPACE_ID]      List conversations
  conversation inspect ID               Read conversation and recent messages
  conversation history ID [JSON_OPTIONS] Read a bounded oldest-first native source page; no submission effects
                                        Continue with snapshot, native_cursor and history_epoch from the reply
                                        JSON_OPTIONS also accepts max_items (1–32) and max_bytes (1–524288)
  conversation export ID FILE            Write complete readable JSON history to a new file
  conversation mark-seen ID [--through UPDATED_AT]
                                        Mark the conversation seen, up to the change shown
  conversation create WORKSPACE_ID [PROVIDER] [TITLE] [--account ID] [--preset NAME]
  conversation send ID TEXT [--request-id ID] [--attach ATTACHMENT_ID]...
                                        Send a prompt; retain ID for safe lost-reply retries.
                                        An unanswered prompt stays held in the client journal
  conversation pending                  List prompts held in the client journal
  conversation deliver                  Deliver each held prompt once, under its original request ID
  conversation cancel ID [--turn TURN_ID] [--wait]
                                        Request cancellation of the active turn; with --turn, only while that turn is active.
                                        The reply is acknowledgement only; --wait also reports the confirmed or unresolved stop
  conversation terminate ID             End the provider process ADE owns for the current attempt, even mid-turn.
                                        Child or background processes the provider started may survive
  conversation resume ID [--continue-interrupted]
                                        Reconnect or resume a stopped agent; after a prompt
                                        whose outcome is unknown, resuming may continue it
  conversation disconnect ID            Stop the conversation's idle agent
  conversation child-transcript ID MESSAGE_ID CHILD_ID [--cursor CURSOR] [--offset 0..100000]
                                        Read one page of a provider child agent's transcript
  conversation answer ID REQUEST_ID DECISION [ANSWERS_JSON]
                                        Answer a pending native request once; DECISION is accept, decline, cancel, or answer
                                        For questions, pass a JSON object of question IDs to text or text arrays
`

/**
 * Waits for the Stop `operationId` to leave `requested`. The daemon bounds that
 * wait with its own settlement window, so this loop ends; a later Stop that
 * replaces the record is reported as such rather than awaited.
 */
async function settledStop(socketPath: string, conversationId: string, operationId: string) {
  for (;;) {
    const { conversation } = decodeReply(
      'conversation.get',
      await requestDaemon(socketPath, 'conversation.get', { conversation_id: conversationId, limit: 1 }),
    )
    const stop = conversation.stop
    if (!stop || stop.operation_id !== operationId) {
      throw new CliError('conflict', 'A later Stop replaced this one; inspect the conversation for its outcome.')
    }
    if (stop.outcome !== 'requested') return stop
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** The SDK's readable export, with its failures as CLI errors. */
async function exportConversation(socketPath: string, conversationId: string, destination: string) {
  try {
    return await exportReadable(socketPath, conversationId, destination)
  } catch (error) {
    if (error instanceof ExportError) throw new CliError(error.code, error.message)
    if (error instanceof DaemonRequestError || error instanceof CliError) throw error
    throw new CliError('invalid_request', `Cannot write export file: ${String(error)}`)
  }
}

export async function runConversationCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area === 'conversation' && action === 'list') {
    const all = (await catalog(socketPath)).conversations
    if (!Array.isArray(all)) throw new CliError('protocol', 'Daemon catalog has no conversations.')
    return {
      type: 'conversations',
      conversations: rest[0] ? all.filter((item) => item?.workspace_id === rest[0]) : all,
    }
  }
  if (area === 'conversation' && action === 'inspect') {
    return requestDaemon(socketPath, 'conversation.get', { conversation_id: required(rest[0], 'ID') })
  }
  if (area === 'conversation' && action === 'history') {
    if (rest.length > 2) throw new CliError('usage', 'conversation history accepts ID [JSON_OPTIONS].')
    return call(socketPath, 'conversation.history', {
      ...(rest[1] ? jsonObject(rest[1], 'JSON_OPTIONS') : {}),
      conversation_id: required(rest[0], 'ID'),
    })
  }
  if (area === 'conversation' && action === 'mark-seen') {
    const parsed = parseWords(rest, ['--through'], [], 'conversation mark-seen')
    const [id] = positionals(parsed, 1, 'conversation mark-seen requires ID')
    const through = parsed.options['--through']
    return call(socketPath, 'conversation.mark_seen', {
      conversation_id: id!,
      ...(through ? { through: boundedInteger(through, '--through', 0, Number.MAX_SAFE_INTEGER) } : {}),
    })
  }
  if (area === 'conversation' && action === 'export') {
    if (rest.length !== 2) throw new CliError('usage', 'conversation export requires ID FILE.')
    return exportConversation(socketPath, required(rest[0], 'ID'), required(rest[1], 'FILE'))
  }
  if (area === 'conversation' && action === 'create') {
    const usage = 'conversation create accepts WORKSPACE_ID [PROVIDER] [TITLE] [--account ID] [--preset NAME].'
    const flags: Record<string, string> = {}
    const positionals: string[] = []
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index]
      if (word === '--account' || word === '--preset') {
        const value = rest[index + 1]
        if (!value || value.startsWith('--') || word in flags) throw new CliError('usage', usage)
        flags[word] = value
        index++
      } else if (word.startsWith('--')) {
        throw new CliError('usage', usage)
      } else {
        positionals.push(word)
      }
    }
    if (positionals.length > 3) throw new CliError('usage', usage)
    if (positionals[2]?.startsWith('account_') && !('--account' in flags)) {
      throw new CliError('usage', 'Use --account ID to select an account; the third positional value is a title.')
    }
    const preset = flags['--preset']
    // A preset names its provider; an explicit PROVIDER must agree with it.
    const provider = positionals[1] ?? (preset === undefined ? 'codex' : undefined)
    const fields: Fields<'conversation.create'> = {
      operation_id: effectOperationId(),
      workspace_id: required(positionals[0], 'WORKSPACE_ID'),
      ...(provider !== undefined ? { provider } : {}),
      title: positionals[2] ?? 'New Conversation',
      ...(flags['--account'] !== undefined ? { account_id: flags['--account'] } : {}),
      ...(preset !== undefined ? { preset } : {}),
    }
    return decodeReply('conversation.create', await requestDaemon(socketPath, 'conversation.create', fields))
  }
  if (area === 'conversation' && action === 'send') {
    const usage = 'conversation send requires ID TEXT [--request-id ID] [--attach ATTACHMENT_ID]...'
    const [first, second, ...options] = rest
    if (first === undefined || second === undefined || options.length % 2 !== 0) throw new CliError('usage', usage)
    const conversationId = required(first, 'ID')
    const text = required(second, 'TEXT')
    if (conversationId.startsWith('--')) throw new CliError('usage', usage)
    let suppliedId: string | undefined
    const attachmentIds: string[] = []
    for (let index = 0; index < options.length; index += 2) {
      const [flag, value] = [options[index], options[index + 1]!]
      if (flag === '--request-id' && suppliedId === undefined) suppliedId = value
      else if (flag === '--attach' && value && !value.startsWith('--')) attachmentIds.push(value)
      else throw new CliError('usage', usage)
    }
    if (suppliedId !== undefined && (!suppliedId || suppliedId.startsWith('--') || suppliedId.length > 256)) {
      throw new CliError('usage', '--request-id requires an ID of 1 to 256 characters.')
    }
    if (suppliedId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(suppliedId)) {
      throw new CliError('usage', '--request-id must be 1 to 128 letters, digits, "-" or "_".')
    }
    const requestId = suppliedId ?? randomUUID()
    // The daemon's own record of each attachment; it checks them again at admission.
    const attachments: unknown[] = []
    for (const attachment_id of attachmentIds) {
      const inspected = decodeReply(
        'attachment.inspect',
        await requestDaemon(socketPath, 'attachment.inspect', { conversation_id: conversationId, attachment_id }),
      )
      attachments.push(inspected.attachment)
    }
    const response = await withJournals(({ send }, profileId) =>
      journalFailure(() =>
        sendJournaled(send, { endpoint: socketPath, profileId, conversationId }, { requestId, text, attachments }),
      ),
    )
    return { ...decodeReply('agent.send', response), request_id: requestId }
  }
  if (area === 'conversation' && action === 'pending') {
    if (rest.length !== 0) throw new CliError('usage', 'conversation pending takes no arguments.')
    return withJournals(async ({ send }, profileId) => ({
      type: 'held_sends',
      sends: (await heldDirectSends(send, profileId)).map((record) => ({
        request_id: record.requestId,
        conversation_id: record.conversationId,
        text: record.text,
        ...(record.restoreHold ? { restore_hold: true } : {}),
      })),
    }))
  }
  if (area === 'conversation' && action === 'deliver') {
    if (rest.length !== 0) throw new CliError('usage', 'conversation deliver takes no arguments.')
    return withJournals(async ({ send }, profileId) => ({
      type: 'held_sends_delivered',
      results: await deliverHeldSends(send, socketPath, profileId),
    }))
  }
  if (area === 'conversation' && action === 'cancel') {
    const parsed = parseWords(rest, ['--turn'], ['--wait'], 'conversation cancel')
    const [conversation_id] = positionals(parsed, 1, 'conversation cancel requires ID [--turn TURN_ID] [--wait]')
    const turn = parsed.options['--turn']
    const { conversation } = decodeReply(
      'conversation.get',
      await requestDaemon(socketPath, 'conversation.get', { conversation_id }),
    )
    const source_attempt_id = conversation.runtime_run
    const submission_id = conversation.runtime_submission
    const target_turn_id = turn ?? conversation.active_turn_id ?? undefined
    // The daemon's own first refusal, so the CLI and the SDK refuse alike.
    if (!['starting', 'running', 'waiting', 'cancelling'].includes(conversation.status)) {
      throw new CliError('daemon', 'Agent has no active turn')
    }
    if (!source_attempt_id || !submission_id) {
      throw new CliError('usage', 'Conversation has no active cancellation target.')
    }
    const outcome = decodeReply(
      'agent.cancel',
      await requestDaemon(socketPath, 'agent.cancel', {
        operation_id: effectOperationId(),
        conversation_id,
        source_attempt_id,
        submission_id,
        ...(target_turn_id === undefined ? {} : { turn_id: target_turn_id }),
      }),
    )
    if (!parsed.flags.has('--wait')) return outcome
    return { ...outcome, stop: await settledStop(socketPath, conversation_id, outcome.operation_id) }
  }
  if (area === 'conversation' && action === 'terminate') {
    if (rest.length !== 1) throw new CliError('usage', 'conversation terminate requires ID.')
    const conversation_id = required(rest[0], 'ID')
    const { conversation } = decodeReply(
      'conversation.get',
      await requestDaemon(socketPath, 'conversation.get', { conversation_id }),
    )
    if (!conversation.runtime_run) throw new CliError('usage', 'Conversation has no provider process to terminate.')
    return decodeReply(
      'agent.terminate',
      await requestDaemon(socketPath, 'agent.terminate', {
        operation_id: effectOperationId(),
        conversation_id,
        source_attempt_id: conversation.runtime_run,
      }),
    )
  }
  if (area === 'conversation' && action === 'resume') {
    const continueInterrupted = rest[1] === '--continue-interrupted'
    if (rest.length !== (continueInterrupted ? 2 : 1))
      throw new CliError('usage', 'conversation resume requires ID [--continue-interrupted].')
    return requestDaemon(socketPath, 'agent.resume', {
      operation_id: effectOperationId(),
      conversation_id: required(rest[0], 'ID'),
      ...(continueInterrupted ? { continue_interrupted: true } : {}),
    })
  }
  if (area === 'conversation' && (action === 'resume' || action === 'disconnect')) {
    if (rest.length !== 1) throw new CliError('usage', `conversation ${action} requires ID.`)
    const op = ({ resume: 'agent.resume', disconnect: 'agent.disconnect' } as const)[action]
    return requestDaemon(socketPath, op, {
      operation_id: effectOperationId(),
      conversation_id: required(rest[0], 'ID'),
    })
  }
  if (area === 'conversation' && action === 'child-transcript') {
    const parsed = parseWords(rest, ['--cursor', '--offset'], [], 'conversation child-transcript')
    const [conversation_id, message_id, child_id] = positionals(
      parsed,
      3,
      'conversation child-transcript requires ID MESSAGE_ID CHILD_ID',
    )
    const { '--cursor': cursor, '--offset': offset } = parsed.options
    return call(socketPath, 'agent.child_transcript', {
      conversation_id,
      message_id,
      child_id,
      ...(cursor === undefined ? {} : { cursor }),
      ...(offset === undefined ? {} : { offset: boundedInteger(offset, 'OFFSET', 0, 100_000) }),
    })
  }
  if (area === 'conversation' && action === 'answer') {
    if (rest.length < 3 || rest.length > 4) {
      throw new CliError('usage', 'conversation answer requires ID REQUEST_ID DECISION [ANSWERS_JSON].')
    }
    const conversationId = required(rest[0], 'ID')
    const requestId = required(rest[1], 'REQUEST_ID')
    const decision = required(rest[2], 'DECISION')
    const answerJson = rest[3]
    if (!['accept', 'decline', 'cancel', 'answer'].includes(decision)) {
      throw new CliError('usage', 'DECISION must be accept, decline, cancel, or answer.')
    }
    if ((decision === 'answer') !== (answerJson !== undefined)) {
      throw new CliError('usage', 'ANSWERS_JSON is required only for the answer decision.')
    }
    const answers = answerJson === undefined ? undefined : jsonObject(answerJson, 'ANSWERS_JSON')
    if (
      answers &&
      Object.values(answers).some(
        (value) =>
          typeof value !== 'string' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string')),
      )
    ) {
      throw new CliError('usage', 'ANSWERS_JSON values must be text or arrays of text.')
    }
    const snapshot = decodeReply(
      'conversation.get',
      await requestDaemon(socketPath, 'conversation.get', { conversation_id: conversationId }),
    )
    const pending = snapshot.requests.find((candidate) => candidate.id === requestId)
    if (!pending) throw new CliError('invalid_request', 'Native request is no longer pending.')
    const normalizedAnswers: Record<string, string[]> = {}
    for (const [questionId, value] of Object.entries(answers ?? {})) {
      normalizedAnswers[questionId] = typeof value === 'string' ? [value] : (value as string[])
    }
    const answer: Fields<'agent.answer'>['answer'] =
      decision === 'answer' ? { kind: 'questions', answers: normalizedAnswers } : { kind: 'choice', value: decision }
    const fields: Fields<'agent.answer'> = {
      operation_id: effectOperationId(),
      conversation_id: pending.conversation_id,
      request_id: pending.id,
      ...(pending.source_attempt_id === undefined ? {} : { source_attempt_id: pending.source_attempt_id }),
      request_revision: pending.revision,
      answer,
    }
    return decodeReply('agent.answer', await call(socketPath, 'agent.answer', fields))
  }
  return undefined
}
