import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  dailyUseCommand,
  type DailyUseCommand,
  type DailyUseOperation,
  type DailyUseRequest,
  type DailyUseResponse,
} from '@ade/client'
import { CliError, jsonObject, namedOptions, required, type CommandResult } from '../shared.js'

export const orchestrationUsage = `  child delegate PARENT_ID PROVIDER TASK --workspace same|new-worktree --account inherit|ambient|ACCOUNT_ID
        [--repository-id ID --branch NAME] [--title TITLE] [--as-agent CONVERSATION_ID] [--operation-id ID]
        [--context ATTACHMENT_ID,...]
                                        Start a child conversation; its task is queued, not completed.
                                        new-worktree first creates BRANCH in a new worktree and opens it.
                                        --context copies the parent's attachments to the child's task
  child list PARENT_ID                  List a conversation's delegated children and their status
  child get CHILD_ID                    Read one child and its parent link
  child send CHILD_ID TEXT [--as-agent CONVERSATION_ID] [--operation-id ID]
                                        Queue a message for a delegated child
  child wait CHILD_ID [--message-id ID] [--timeout-ms 0..86400000]
                                        Wait for the child's turn to settle, ask for input or time out
  child answer CHILD_ID REQUEST_ID accept|decline|cancel|answer [--answers JSON] [--as-agent CONVERSATION_ID]
                                        Answer a question or approval the child waits on, once
  child reply CHILD_ID TEXT [--as-agent CHILD_ID] [--operation-id ID]
                                        Queue a message from the child for its parent
  child messages CHILD_ID               List messages between the child and its parent, both ways
  Retain --operation-id for child delegate, child send and child reply; after a lost reply, retry with the same ID
  and arguments. A generated ID cannot be recovered, so an uncertain retry could duplicate the work.
`

type Caller = DailyUseRequest<'orchestration.delegate'>['caller']

const POLL_MS = 500
const WORKTREE_TIMEOUT_MS = 300_000

export function operationId(value: string | undefined): string {
  if (value === undefined) return randomUUID()
  if (value.length < 1 || value.length > 256)
    throw new CliError('usage', '--operation-id requires 1 to 256 characters.')
  return value
}

export function caller(agent: string | undefined): Caller {
  return agent === undefined ? { kind: 'user' } : { kind: 'agent', conversation_id: agent }
}

function timeout(value: string | undefined): number {
  if (value === undefined) return 0
  const number = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number > 86_400_000) {
    throw new CliError('usage', '--timeout-ms must be an integer from 0 to 86400000.')
  }
  return number
}

/** A typed request; the reply is checked against its contract. */
export async function command<O extends DailyUseOperation>(
  socketPath: string,
  op: O,
  fields: Omit<DailyUseRequest<O>, 'op'>,
): Promise<DailyUseResponse<O>> {
  return dailyUseCommand<O>(socketPath, { op, ...fields } as unknown as DailyUseCommand<O>)
}

/** Create BRANCH in a new worktree, wait for the lifecycle operation, and open it as a workspace. */
export async function newWorktree(
  socketPath: string,
  repositoryId: string,
  branch: string,
  worktreeOperationId: string,
): Promise<{ workspace_id: string; repository_id: string; worktree_operation_id: string }> {
  await command(socketPath, 'worktree.switch', {
    repository_id: repositoryId,
    operation_id: worktreeOperationId,
    target: branch,
    create: true,
  })
  const deadline = Date.now() + WORKTREE_TIMEOUT_MS
  for (;;) {
    const { operation } = await command(socketPath, 'worktree.operation', {
      repository_id: repositoryId,
      operation_id: worktreeOperationId,
    })
    if (operation.status === 'succeeded' && operation.worktree_path) {
      const opened = await command(socketPath, 'workspace.open', { path: operation.worktree_path })
      return {
        workspace_id: opened.workspace.id,
        repository_id: repositoryId,
        worktree_operation_id: worktreeOperationId,
      }
    }
    if (operation.status !== 'running') {
      throw new CliError(
        'daemon',
        `Worktree operation ${worktreeOperationId} ended ${operation.status}` +
          `${operation.error ? `: ${operation.error}` : ''}. Inspect it before retrying.`,
      )
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        'timeout',
        `Worktree operation ${worktreeOperationId} is still running. ` +
          'Retry with the same --operation-id to continue.',
      )
    }
    await sleep(POLL_MS)
  }
}

async function delegate(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [parent, provider, task, ...flags] = rest
  const options = namedOptions(
    flags,
    ['--workspace', '--account', '--repository-id', '--branch', '--title', '--as-agent', '--operation-id', '--context'],
    'child delegate',
  )
  const id = operationId(options['--operation-id'])
  const accountOption = required(options['--account'], '--account')
  const account: DailyUseRequest<'orchestration.delegate'>['account'] =
    accountOption === 'inherit' || accountOption === 'ambient'
      ? { mode: accountOption }
      : { mode: 'managed', account_id: accountOption }
  const mode = required(options['--workspace'], '--workspace')
  let workspace: DailyUseRequest<'orchestration.delegate'>['workspace']
  if (mode === 'same') {
    if (options['--repository-id'] || options['--branch']) {
      throw new CliError('usage', '--repository-id and --branch apply only to --workspace new-worktree.')
    }
    workspace = { mode: 'same' }
  } else if (mode === 'new-worktree') {
    // The worktree operation ID derives from the delegation's, so a retry resumes the same worktree.
    workspace = {
      mode: 'new_worktree',
      ...(await newWorktree(
        socketPath,
        required(options['--repository-id'], '--repository-id'),
        required(options['--branch'], '--branch'),
        `${id}:worktree`,
      )),
    }
  } else {
    throw new CliError('usage', '--workspace must be same or new-worktree.')
  }
  const parentId = required(parent, 'PARENT_ID')
  // Context attachments are named by ID; their metadata comes from the parent, which must own them.
  const context =
    options['--context'] === undefined
      ? []
      : await Promise.all(
          options['--context'].split(',').map(
            async (attachment) =>
              (
                await command(socketPath, 'attachment.inspect', {
                  conversation_id: parentId,
                  attachment_id: required(attachment, 'ATTACHMENT_ID'),
                })
              ).attachment,
          ),
        )
  return command(socketPath, 'orchestration.delegate', {
    operation_id: id,
    parent_conversation_id: parentId,
    caller: caller(options['--as-agent']),
    provider: required(provider, 'PROVIDER'),
    account,
    workspace,
    task: required(task, 'TASK'),
    ...(options['--title'] ? { title: options['--title'] } : {}),
    ...(context.length ? { context_attachments: context } : {}),
  })
}

/** Repeat the non-blocking daemon wait until it has an answer or its deadline passes. */
async function wait(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [child, ...flags] = rest
  const options = namedOptions(flags, ['--message-id', '--timeout-ms'], 'child wait')
  const op = 'orchestration.child.wait'
  const base = {
    child_conversation_id: required(child, 'CHILD_ID'),
    ...(options['--message-id'] ? { message_id: options['--message-id'] } : {}),
  }
  let reply = await command(socketPath, op, { ...base, timeout_ms: timeout(options['--timeout-ms']) })
  while (!reply.done) {
    await sleep(Math.max(0, Math.min(POLL_MS, reply.deadline_ms - Date.now())))
    reply = await command(socketPath, op, { ...base, deadline_ms: reply.deadline_ms })
  }
  return reply
}

const decisions = ['accept', 'decline', 'cancel', 'answer'] as const

/** Answer one of the child's pending requests from the parent's side. */
async function answer(socketPath: string, rest: string[]): Promise<CommandResult> {
  const [child, request, decision, ...flags] = rest
  const options = namedOptions(flags, ['--answers', '--as-agent'], 'child answer')
  if (!decisions.includes(decision as (typeof decisions)[number])) {
    throw new CliError('usage', 'DECISION must be accept, decline, cancel, or answer.')
  }
  if ((decision === 'answer') !== (options['--answers'] !== undefined)) {
    throw new CliError('usage', '--answers is required only for the answer decision.')
  }
  const answers = options['--answers'] === undefined ? undefined : jsonObject(options['--answers'], '--answers')
  return command(socketPath, 'orchestration.child.answer', {
    child_conversation_id: required(child, 'CHILD_ID'),
    request_id: required(request, 'REQUEST_ID'),
    caller: caller(options['--as-agent']),
    decision,
    ...(answers === undefined ? {} : { answers }),
  })
}

export async function runOrchestrationCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'child') return undefined
  if (action === 'delegate') return delegate(socketPath, rest)
  if (action === 'list' && rest.length === 1) {
    return command(socketPath, 'orchestration.children', { parent_conversation_id: required(rest[0], 'PARENT_ID') })
  }
  if (action === 'get' && rest.length === 1) {
    return command(socketPath, 'orchestration.child.get', { child_conversation_id: required(rest[0], 'CHILD_ID') })
  }
  if (action === 'send') {
    const [child, text, ...flags] = rest
    const options = namedOptions(flags, ['--as-agent', '--operation-id'], 'child send')
    return command(socketPath, 'orchestration.child.send', {
      operation_id: operationId(options['--operation-id']),
      child_conversation_id: required(child, 'CHILD_ID'),
      caller: caller(options['--as-agent']),
      text: required(text, 'TEXT'),
    })
  }
  if (action === 'wait') return wait(socketPath, rest)
  if (action === 'answer') return answer(socketPath, rest)
  if (action === 'reply') {
    const [child, text, ...flags] = rest
    const options = namedOptions(flags, ['--as-agent', '--operation-id'], 'child reply')
    return command(socketPath, 'orchestration.parent.send', {
      operation_id: operationId(options['--operation-id']),
      child_conversation_id: required(child, 'CHILD_ID'),
      caller: caller(options['--as-agent']),
      text: required(text, 'TEXT'),
    })
  }
  if (action === 'messages' && rest.length === 1) {
    return command(socketPath, 'orchestration.child.messages', { child_conversation_id: required(rest[0], 'CHILD_ID') })
  }
  return undefined
}
