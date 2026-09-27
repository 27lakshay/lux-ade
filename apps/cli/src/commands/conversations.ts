import { randomUUID } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { call, DaemonRequestError, decodeDailyUseResponse, requestDaemon, type DailyUseOperation,
  type DailyUseRequest, type DailyUseResponse } from '@ade/client'
import { boundedInteger, catalog, CliError, jsonObject, object, parseWords, positionals, required,
  type CommandResult } from '../shared.js'

/** A typed request body: the operation's contract without its `op`. */
export type Fields<O extends DailyUseOperation> = Omit<DailyUseRequest<O>, 'op'>

/** Check a daemon reply against its contract; a mismatch is a protocol error. */
export function decodeReply<O extends DailyUseOperation>(op: O, response: unknown): DailyUseResponse<O> {
  try { return decodeDailyUseResponse(op, response) as DailyUseResponse<O> }
  catch (error) { throw new CliError('protocol', `Daemon ${op} reply failed its contract: ${String(error)}`) }
}

export const conversationUsage = `  conversation list [WORKSPACE_ID]      List conversations
  conversation inspect ID               Read conversation and recent messages
  conversation export ID FILE            Write complete readable JSON history to a new file
  conversation create WORKSPACE_ID [PROVIDER] [TITLE] [--account ID] [--preset NAME]
  conversation send ID TEXT [--request-id ID]
                                        Send a prompt; retain ID for safe lost-reply retries
  conversation cancel ID                Request cancellation of the active turn
  conversation resume ID                Reconnect or resume a stopped agent
  conversation disconnect ID            Stop the conversation's idle agent
  conversation child-transcript ID MESSAGE_ID CHILD_ID [--cursor CURSOR] [--offset 0..100000]
                                        Read one page of a provider child agent's transcript
  conversation answer ID REQUEST_ID DECISION [ANSWERS_JSON]
                                        Answer a pending native request once; DECISION is accept, decline, cancel, or answer
                                        For questions, pass a JSON object of question IDs to text or text arrays
`

/** Export through the public paginated read without holding the whole transcript in memory. */
async function exportConversation(socketPath: string, conversationId: string, destination: string): Promise<Record<string, unknown>> {
  const pageSize = 100
  const first = await requestDaemon(socketPath, 'conversation.get', { conversation_id: conversationId, limit: pageSize })
  if (first.type !== 'conversation_snapshot') throw new CliError('protocol', 'Daemon returned an unexpected conversation response.')
  const conversation = object(first.conversation)
  if (conversation.id !== conversationId || typeof first.boot_id !== 'string' || !first.boot_id ||
    !Number.isSafeInteger(first.revision) || (first.revision as number) < 0) {
    throw new CliError('protocol', 'Daemon returned invalid conversation identity or revision.')
  }
  const bootId = first.boot_id
  const revision = first.revision
  const conversationRecord = JSON.stringify(conversation)
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(temporary, 'wx', 0o600) }
  catch (error) { throw new CliError('invalid_request', `Cannot create export file: ${String(error)}`) }
  let fileClosed = false
  let count = 0
  let oldest = Number.POSITIVE_INFINITY
  let page = first
  try {
    await file.writeFile(`{\n  "format": "ade-conversation-history-v1",\n  "scope": "conversation-history",\n  "message_order": "newest_first",\n  "boot_id": ${JSON.stringify(bootId)},\n  "revision": ${revision},\n  "conversation": ${JSON.stringify(conversation, null, 2)},\n  "messages": [\n`)
    for (;;) {
      if (page.type !== 'conversation_snapshot' || page.boot_id !== bootId || page.revision !== revision ||
        !page.conversation || typeof page.conversation !== 'object' ||
        (page.conversation as Record<string, unknown>).id !== conversationId ||
        JSON.stringify(page.conversation) !== conversationRecord ||
        !Array.isArray(page.messages) || page.messages.length > pageSize) {
        throw new CliError('protocol', 'Conversation changed or daemon returned an invalid history page; retry the export.')
      }
      const messages = page.messages as unknown[]
      let previous = 0
      for (const value of messages) {
        const message = object(value)
        const sequence = message.sequence
        if (message.conversation_id !== conversationId || typeof message.id !== 'string' || !message.id ||
          !Number.isSafeInteger(sequence) || (sequence as number) <= previous || (sequence as number) >= oldest ||
          typeof message.role !== 'string' || typeof message.kind !== 'string' ||
          typeof message.text !== 'string' || typeof message.status !== 'string') {
          throw new CliError('protocol', 'Daemon returned an invalid or overlapping history page; retry the export.')
        }
        previous = sequence as number
      }
      for (let index = messages.length - 1; index >= 0; index--) {
        await file.writeFile(`${count ? ',\n' : ''}${JSON.stringify(messages[index], null, 2)}`)
        count++
      }
      if (messages.length < pageSize) break
      oldest = (messages[0] as Record<string, unknown>).sequence as number
      page = await requestDaemon(socketPath, 'conversation.get', {
        conversation_id: conversationId, before: oldest, limit: pageSize,
      })
    }
    await file.writeFile('\n  ]\n}\n')
    await file.sync()
    await file.close()
    fileClosed = true
    try { await link(temporary, destination) }
    catch (error) {
      const reason = error as NodeJS.ErrnoException
      throw new CliError('invalid_request', reason.code === 'EEXIST'
        ? 'Export destination already exists; choose a new file.'
        : `Cannot publish export file: ${String(error)}`)
    }
    try {
      const directory = await open(dirname(destination), 'r')
      try { await directory.sync() }
      finally { await directory.close() }
    } catch (error) {
      throw new CliError('invalid_request', `Export was created, but directory sync failed; durability is unconfirmed: ${String(error)}`)
    }
    return { type: 'conversation_export', conversation_id: conversationId, file: destination,
      format: 'ade-conversation-history-v1', message_count: count, boot_id: bootId, revision }
  } catch (error) {
    if (error instanceof CliError || error instanceof DaemonRequestError) throw error
    throw new CliError('invalid_request', `Cannot write export file: ${String(error)}`)
  } finally {
    if (!fileClosed) await file.close()
    await unlink(temporary).catch(() => undefined)
  }
}

export async function runConversationCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area === 'conversation' && action === 'list') {
    const all = (await catalog(socketPath)).conversations
    if (!Array.isArray(all)) throw new CliError('protocol', 'Daemon catalog has no conversations.')
    return { type: 'conversations', conversations: rest[0] ? all.filter((item) => item?.workspace_id === rest[0]) : all }
  }
  if (area === 'conversation' && action === 'inspect') {
    return requestDaemon(socketPath, 'conversation.get', { conversation_id: required(rest[0], 'ID') })
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
      const word = rest[index]!
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
      workspace_id: required(positionals[0], 'WORKSPACE_ID'),
      ...(provider !== undefined ? { provider } : {}),
      title: positionals[2] ?? 'New Conversation',
      ...(flags['--account'] !== undefined ? { account_id: flags['--account'] } : {}),
      ...(preset !== undefined ? { preset } : {}),
    }
    return decodeReply('conversation.create', await requestDaemon(socketPath, 'conversation.create', fields))
  }
  if (area === 'conversation' && action === 'send') {
    if (rest.length !== 2 && (rest.length !== 4 || rest[2] !== '--request-id')) {
      throw new CliError('usage', 'conversation send requires ID TEXT [--request-id ID].')
    }
    const conversationId = required(rest[0], 'ID')
    const text = required(rest[1], 'TEXT')
    if (conversationId.startsWith('--')) {
      throw new CliError('usage', 'conversation send requires ID TEXT [--request-id ID].')
    }
    const suppliedId = rest[3]
    if (suppliedId !== undefined && (!suppliedId || suppliedId.startsWith('--') || suppliedId.length > 256)) {
      throw new CliError('usage', '--request-id requires an ID of 1 to 256 characters.')
    }
    const requestId = suppliedId ?? randomUUID()
    const response = await requestDaemon(socketPath, 'agent.send', { conversation_id: conversationId, request_id: requestId, text })
    return { ...response, request_id: requestId }
  }
  if (area === 'conversation' && (action === 'cancel' || action === 'resume' || action === 'disconnect')) {
    if (rest.length !== 1) throw new CliError('usage', `conversation ${action} requires ID.`)
    const op = ({ cancel: 'agent.cancel', resume: 'agent.resume', disconnect: 'agent.disconnect' } as const)[action]
    return requestDaemon(socketPath, op, { conversation_id: required(rest[0], 'ID') })
  }
  if (area === 'conversation' && action === 'child-transcript') {
    const parsed = parseWords(rest, ['--cursor', '--offset'], [], 'conversation child-transcript')
    const [conversation_id, message_id, child_id] = positionals(parsed, 3,
      'conversation child-transcript requires ID MESSAGE_ID CHILD_ID')
    const { '--cursor': cursor, '--offset': offset } = parsed.options
    return call(socketPath, 'agent.child_transcript', { conversation_id, message_id, child_id,
      ...(cursor === undefined ? {} : { cursor }),
      ...(offset === undefined ? {} : { offset: boundedInteger(offset, 'OFFSET', 0, 100_000) }) })
  }
  if (area === 'conversation' && action === 'answer') {
    if (rest.length < 3 || rest.length > 4) {
      throw new CliError('usage', 'conversation answer requires ID REQUEST_ID DECISION [ANSWERS_JSON].')
    }
    const [conversationId, requestId, decision, answerJson] = rest
    if (!['accept', 'decline', 'cancel', 'answer'].includes(decision)) {
      throw new CliError('usage', 'DECISION must be accept, decline, cancel, or answer.')
    }
    if ((decision === 'answer') !== (answerJson !== undefined)) {
      throw new CliError('usage', 'ANSWERS_JSON is required only for the answer decision.')
    }
    const answers = answerJson === undefined ? undefined : jsonObject(answerJson, 'ANSWERS_JSON')
    if (answers && Object.values(answers).some((value) =>
      typeof value !== 'string' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string')))) {
      throw new CliError('usage', 'ANSWERS_JSON values must be text or arrays of text.')
    }
    return requestDaemon(socketPath, 'agent.answer', {
      conversation_id: required(conversationId, 'ID'),
      request_id: required(requestId, 'REQUEST_ID'), decision,
      ...(answers === undefined ? {} : { answers }),
    })
  }
  return undefined
}
