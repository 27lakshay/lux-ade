// Scripted native turns for the Claude Agent SDK double (worker-test-sdk.mjs). Each runs
// one input: `turn.input` is the native user message, `turn.emit` reports (and, for user
// and assistant entries, stores) a native message, and `turn.interrupt` answers
// Query.interrupt() while the input is active.
import { randomUUID } from 'node:crypto'
import { record, released, sleep } from './worker-test-store.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const echo = (turn) => turn.emit({ ...turn.input })
const say = (turn, id, text, uuid = turn.input.uuid) =>
  turn.emit({
    type: 'assistant',
    uuid: 'envelope-' + id,
    user_message_uuid: uuid,
    message: { id, content: [{ type: 'text', text }] },
  })
const finish = (turn, extra = {}, uuid = turn.input.uuid) => {
  turn.interrupt = null
  const outcome = extra.is_error ? {} : { subtype: 'success', is_error: false, result: 'complete' }
  turn.emit({ type: 'result', user_message_uuid: uuid, ...outcome, ...extra })
}
const toolUse = (turn, id, name, input, uuid = turn.input.uuid) =>
  turn.emit({
    type: 'assistant',
    uuid: 'envelope-' + id,
    user_message_uuid: uuid,
    message: { id: 'api-' + id, content: [{ type: 'tool_use', id, name, input }] },
  })
const toolResult = (turn, id, content, extra = {}) =>
  turn.emit({
    type: 'user',
    uuid: 'result-' + id,
    ...extra,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  })
const streamStart = (turn, id) =>
  turn.emit({
    type: 'stream_event',
    user_message_uuid: turn.input.uuid,
    event: { type: 'message_start', message: { id, content: [] } },
  })
const partial = (turn, event) => turn.emit({ type: 'stream_event', event, parent_tool_use_id: null })
const deltas = (turn, texts) => {
  partial(turn, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const text of texts)
    partial(turn, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
}
/** Stream `texts`, then report them as one assistant message. */
const reply = (turn, id, texts) => {
  streamStart(turn, id)
  deltas(turn, texts)
  partial(turn, { type: 'content_block_stop', index: 0 })
  partial(turn, { type: 'message_stop' })
  say(turn, id, texts.join(''))
}
const askPermission = (turn, toolName, input, ids, signal = new AbortController().signal) =>
  turn.options.canUseTool(toolName, input, { ...ids, suggestions: [], signal })

const usageFigures = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 }
const rateLimit = (turn, info) =>
  turn.emit({
    type: 'rate_limit_event',
    rate_limit_info: { rateLimitType: 'five_hour', resetsAt: 4102444800, ...info },
  })
// `usage` and `usage-unpriced` report fixture figures, `usage-exhausted` a used-up
// five-hour limit; other prompts report no usage.
function usageResult(turn, text) {
  if (text === 'usage-exhausted') rateLimit(turn, { status: 'rejected', utilization: 1 })
  if (text !== 'usage' && text !== 'usage-unpriced') return {}
  for (const [key, add] of Object.entries({ ...usageFigures, costUSD: 0.5 })) turn.usage[key] += add
  rateLimit(turn, { status: 'allowed_warning', utilization: 0.25 })
  return {
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    modelUsage: {
      'claude-fixture': {
        ...turn.usage,
        webSearchRequests: 0,
        contextWindow: 200000,
        maxOutputTokens: 32000,
        ...(text === 'usage-unpriced' ? { costBasis: 'unknown' } : {}),
      },
    },
    total_cost_usd: turn.usage.costUSD,
  }
}

async function request(turn, text) {
  const uuid = turn.input.uuid
  const toolName = text === 'questions' ? 'AskUserQuestion' : 'Bash'
  const toolInput =
    text === 'questions'
      ? { questions: [{ question: 'First?' }, { question: 'Second?' }] }
      : { command: 'echo fixture' }
  const toolUseID = 'tool-' + uuid
  echo(turn)
  toolUse(turn, toolUseID, toolName, toolInput)
  await tick()
  record({ method: 'canUseTool', toolName, input: toolInput, toolUseID })
  const controller = new AbortController()
  turn.interrupt = async () => {
    controller.abort()
    return { still_queued: [] }
  }
  const answer = await askPermission(
    turn,
    toolName,
    toolInput,
    { requestId: 'request-' + uuid, toolUseID },
    controller.signal,
  )
  record({ method: 'answer', answer })
  toolResult(turn, toolUseID, 'fixture tool outcome')
  say(turn, 'native-reply-' + uuid, JSON.stringify(answer))
  if (controller.signal.aborted)
    finish(turn, { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', errors: [] })
  else finish(turn)
}

async function callbackBeforeEcho(turn, text) {
  if (text === 'autonomous-callback-before-echo') {
    await askPermission(
      turn,
      'Bash',
      { command: 'old autonomous command' },
      { requestId: 'native-old-request', toolUseID: 'native-old-autonomous' },
    )
    echo(turn)
    return finish(turn)
  }
  const controller = new AbortController()
  turn.interrupt = async () => {
    controller.abort()
    return { still_queued: [] }
  }
  const answer = await askPermission(
    turn,
    'Bash',
    { command: 'echo safe' },
    { requestId: 'native-request', toolUseID: 'native-tool' },
    controller.signal,
  )
  echo(turn)
  say(turn, 'native-reply', JSON.stringify(answer))
  if (controller.signal.aborted)
    finish(turn, {
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_tools',
      errors: ['Tool interrupted'],
    })
  else finish(turn)
}

async function callback(turn, text) {
  const controller = new AbortController()
  if (text === 'callback-already-aborted') controller.abort()
  const answer = askPermission(
    turn,
    'Bash',
    { command: 'echo safe' },
    { requestId: 'native-request', toolUseID: 'native-tool' },
    controller.signal,
  )
  if (text === 'callback-withdraw') setImmediate(() => controller.abort())
  const settled = await answer
  if (text === 'callback-answer-abort') controller.abort()
  say(turn, 'native-reply', JSON.stringify(settled))
  finish(turn)
}

function childLifecycle(turn) {
  toolUse(turn, 'native-agent-tool', 'Agent', { description: 'Inspect', prompt: 'Inspect', run_in_background: true })
  const task = (subtype, extra) =>
    turn.emit({ type: 'system', subtype, task_id: 'native-child', tool_use_id: 'native-agent-tool', ...extra })
  task('task_started', { task_type: 'local_agent', description: 'Inspect' })
  turn.emit({
    type: 'assistant',
    parent_tool_use_id: 'native-agent-tool',
    uuid: 'child-private-envelope',
    message: { id: 'child-api', content: [{ type: 'text', text: 'Child transcript stays separate' }] },
  })
  task('task_progress', { summary: 'Inspecting' })
  task('task_notification', { tool_use_id: 'stale-tool', status: 'failed', summary: 'stale' })
  task('task_notification', { status: 'completed', summary: 'Complete' })
  finish(turn)
}

// A background Bash task outlives the turn that started it. Once the test creates
// 'release-background', the session reports output no input owns, then the task ends.
function backgroundTask(turn) {
  const task = (subtype, extra) =>
    turn.emit({ type: 'system', subtype, task_id: 'native-background', task_type: 'local_bash', ...extra })
  task('task_started', { description: 'Watch the build' })
  say(turn, 'native-yield', 'Started the build in the background')
  finish(turn)
  void (async () => {
    while (!released('release-background')) await sleep(20)
    turn.emit({
      type: 'assistant',
      uuid: 'envelope-native-autonomous',
      message: { id: 'native-autonomous', content: [{ type: 'text', text: 'The build finished' }] },
    })
    task('task_notification', { status: 'completed', summary: 'Build finished' })
  })()
}

// A typed child agent whose private transcript is stored in the session file.
async function typedSubagents(turn) {
  const { task, tool } = turn.child
  const notify = (subtype, extra) =>
    turn.emit({ type: 'system', subtype, task_id: task, tool_use_id: tool, task_type: 'local_agent', ...extra })
  notify('task_started', { subagent_type: 'research', description: 'Inspect' })
  turn.emit({
    type: 'assistant',
    uuid: randomUUID(),
    parent_tool_use_id: tool,
    message: { content: [{ type: 'text', text: 'Private child transcript' }] },
  })
  await sleep(50)
  notify('task_notification', { status: 'completed', summary: 'Inspection complete' })
}

function typedTools(turn, text) {
  const steps =
    text === 'typed-tasks'
      ? [
          ['TaskCreate', { subject: 'Build' }, { task: { id: 'task-1', subject: 'Build' } }],
          [
            'TaskUpdate',
            { taskId: 'task-1', status: 'completed' },
            { success: true, taskId: 'task-1', updatedFields: ['status'] },
          ],
        ]
      : ['in_progress', 'completed'].map((status) => [
          'TodoWrite',
          { todos: [{ content: 'Inspect', status }] },
          undefined,
        ])
  for (const [name, input, output] of steps) {
    const id = randomUUID()
    toolUse(turn, id, name, input)
    toolResult(
      turn,
      id,
      text === 'typed-tasks' ? 'task operation completed' : 'updated',
      output ? { tool_use_result: output } : {},
    )
  }
}

/** Run one native input. */
export async function scripted(turn, text) {
  const uuid = turn.input.uuid
  if (text === 'approval' || text === 'questions') return request(turn, text)
  if (text === 'autonomous-callback-before-echo' || text === 'callback-before-echo')
    return callbackBeforeEcho(turn, text)
  echo(turn)
  if (text === 'old-autonomous-source') {
    toolUse(turn, 'native-old-autonomous', 'Bash', { command: 'old autonomous command' }, 'untracked-old-input')
    return finish(turn)
  }
  if (text === 'callback-observed-owner') {
    toolUse(turn, 'native-owned-tool', 'Bash', { command: 'owned command' })
    await tick()
    await askPermission(
      turn,
      'Bash',
      { command: 'owned command' },
      { requestId: 'native-owned-request', toolUseID: 'native-owned-tool' },
    )
    return finish(turn)
  }
  if (text.startsWith('callback')) return callback(turn, text)
  if (text === 'child-lifecycle') return childLifecycle(turn)
  if (text === 'background-task') return backgroundTask(turn)
  if (text === 'stream') {
    reply(turn, 'native-text', ['Hello ', 'world'])
    return finish(turn)
  }
  if (text === 'foreign') {
    say(turn, 'native-foreign', 'autonomous output', 'foreign-input')
    finish(turn, {}, 'foreign-input')
    say(turn, 'native-current', 'current output')
    return finish(turn)
  }
  if (text === 'rows') {
    say(turn, 'native-answer', 'Distinct answer')
    toolUse(turn, 'native-call', 'Read', { file_path: 'a.txt' })
    toolResult(turn, 'native-call', 'file contents')
    return finish(turn)
  }
  if (text === 'overflow') {
    say(turn, 'native-overflow', 'x'.repeat(8192))
    return finish(turn)
  }
  if (text === 'mcp') {
    say(turn, 'native-mcp', JSON.stringify(turn.options.mcpServers))
    return finish(turn)
  }
  if (text === 'interrupt') {
    // Wait for native interrupt, which leaves trailing output and an execution failure.
    turn.interrupt = async () => {
      say(turn, 'native-trailing', 'after interrupt')
      finish(turn, {
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['Native API failure after interrupt'],
        terminal_reason: 'api_error',
      })
      return { still_queued: [] }
    }
    return
  }
  if (text === 'hold') {
    // Stream a reply, then hold the turn open until a native interrupt.
    streamStart(turn, 'native-hold-' + uuid)
    deltas(turn, ['Hello ', 'Claude'])
    turn.interrupt = async () => {
      finish(turn, {
        subtype: 'error_during_execution',
        is_error: true,
        errors: [],
        terminal_reason: 'aborted_streaming',
      })
      return { still_queued: [] }
    }
    return
  }
  if (text === 'interrupt-queued') {
    // The native SDK interrupts the turn but keeps this input queued.
    turn.interrupt = async () => ({ still_queued: [uuid] })
    return
  }
  if (text === 'typed-subagents') await typedSubagents(turn)
  if (text === 'typed-tasks' || text === 'typed-plan') typedTools(turn, text)
  reply(turn, 'assistant-' + uuid, ['Hello ', 'Claude'])
  const usage = usageResult(turn, text)
  finish(turn, usage)
  // A task notification the session absorbed after the answer: kept in the chain, never shown.
  if (text === 'absorbed-notification')
    turn.keep({ type: 'system', subtype: 'task_notification', uuid: randomUUID(), absorbed: true })
}
