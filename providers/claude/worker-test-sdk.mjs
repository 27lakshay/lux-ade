import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const directory = process.env.ADE_CLAUDE_WORKER_TEST_DIR
const record = (value) => {
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  appendFileSync(join(directory, 'calls.jsonl'), JSON.stringify({ pid: process.pid, ...value }) + '\n')
}
const history = JSON.parse(process.env.CLAUDE_WORKER_HISTORY ?? '{}')
export async function getSessionInfo(sessionId) {
  return { sessionId, lastModified: 37, fileSize: Buffer.byteLength(JSON.stringify(history[sessionId] ?? [])) }
}
export async function getSessionMessages(session, { offset = 0, limit = 32 } = {}) {
  return (history[session] ?? [])
    .slice(offset, offset + limit)
    .map((message) => ({ parent_tool_use_id: null, session_id: session, ...message }))
}
export async function listSubagents(session) {
  return Object.keys(history)
    .filter((id) => id.startsWith(session + '/'))
    .map((id) => id.slice(session.length + 1))
}
export async function getSubagentMessages(session, child, options) {
  return getSessionMessages(session + '/' + child, options)
}
export function query({ prompt, options }) {
  const session = options.resume ?? options.sessionId ?? 'fixture-session'
  const messages = []
  let wake,
    closed = false,
    inputUuid,
    permissionController
  const emit = (message) => {
    messages.push({ session_id: session, ...message })
    wake?.()
    wake = null
  }
  const emitText = (id, text, uuid = inputUuid) =>
    emit({
      type: 'assistant',
      uuid: 'envelope-' + id,
      user_message_uuid: uuid,
      message: { id, content: [{ type: 'text', text }] },
    })
  const finish = (uuid = inputUuid, is_error = false) =>
    emit({
      type: 'result',
      subtype: is_error ? 'error_during_execution' : 'success',
      user_message_uuid: uuid,
      is_error,
      ...(is_error
        ? { errors: ['Native API failure after interrupt'], terminal_reason: 'api_error' }
        : { result: 'complete' }),
    })
  const initialized = Promise.resolve().then(() => {
    if (process.env.CLAUDE_WORKER_SCENARIO === 'init-failure') throw new Error('native initialization refused')
    emit({
      type: 'system',
      subtype: 'init',
      session_id: process.env.CLAUDE_WORKER_SCENARIO === 'resume-mismatch' ? 'foreign-session' : session,
    })
    return { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] }
  })
  // The reader must consume native init concurrently with the control handshake.
  initialized.catch(() => {})
  const instance = {
    initializationResult: () => initialized,
    interrupt: async () => {
      if (permissionController) permissionController.abort()
      else {
        emitText('native-trailing', 'after interrupt')
        finish(inputUuid, true)
      }
      return { still_queued: [] }
    },
    close() {
      closed = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (messages.length) yield messages.shift()
        else
          await new Promise((resolve) => {
            wake = resolve
          })
      }
    },
  }
  queueMicrotask(async () => {
    for await (const input of prompt) {
      inputUuid = input.uuid
      const scenario = input.message.content.find((block) => block.type === 'text').text
      record({ method: 'send', uuid: inputUuid, text: scenario })
      if (scenario === 'approval' || scenario === 'questions') {
        const toolName = scenario === 'questions' ? 'AskUserQuestion' : 'Bash'
        const toolInput =
          scenario === 'questions'
            ? { questions: [{ question: 'First?' }, { question: 'Second?' }] }
            : { command: 'echo fixture' }
        const toolUseID = 'tool-' + inputUuid
        emit({ type: 'user', uuid: inputUuid, message: input.message })
        emit({
          type: 'assistant',
          uuid: 'native-request-envelope-' + inputUuid,
          user_message_uuid: inputUuid,
          message: {
            id: 'native-request-api-' + inputUuid,
            content: [{ type: 'tool_use', id: toolUseID, name: toolName, input: toolInput }],
          },
        })
        await new Promise((resolve) => setImmediate(resolve))
        record({ method: 'canUseTool', toolName, input: toolInput, toolUseID })
        const answer = await options.canUseTool(toolName, toolInput, {
          requestId: 'request-' + inputUuid,
          toolUseID,
          suggestions: [],
          signal: new AbortController().signal,
        })
        record({ method: 'answer', answer })
        emit({
          type: 'user',
          uuid: 'native-result-' + inputUuid,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUseID, content: 'fixture tool outcome' }],
          },
        })
        emitText('native-reply-' + inputUuid, JSON.stringify(answer))
        finish()
        continue
      }
      if (scenario === 'autonomous-callback-before-echo') {
        await options.canUseTool(
          'Bash',
          { command: 'old autonomous command' },
          {
            requestId: 'native-old-request',
            toolUseID: 'native-old-autonomous',
            suggestions: [],
            signal: new AbortController().signal,
          },
        )
        emit({ type: 'user', uuid: inputUuid, message: input.message })
        finish()
        continue
      }
      if (scenario === 'callback-before-echo') {
        permissionController = new AbortController()
        const answer = await options.canUseTool(
          'Bash',
          { command: 'echo safe' },
          {
            requestId: 'native-request',
            toolUseID: 'native-tool',
            suggestions: [],
            signal: permissionController.signal,
          },
        )
        emit({ type: 'user', uuid: inputUuid, message: input.message })
        emitText('native-reply', JSON.stringify(answer))
        if (permissionController.signal.aborted)
          emit({
            type: 'result',
            subtype: 'error_during_execution',
            user_message_uuid: inputUuid,
            is_error: true,
            terminal_reason: 'aborted_tools',
            errors: ['Tool interrupted'],
          })
        else finish()
        permissionController = null
        continue
      }
      emit({ type: 'user', uuid: inputUuid, message: input.message })
      if (scenario === 'old-autonomous-source') {
        emit({
          type: 'assistant',
          uuid: 'native-old-envelope',
          user_message_uuid: 'untracked-old-input',
          message: {
            id: 'native-old-api',
            content: [
              {
                type: 'tool_use',
                id: 'native-old-autonomous',
                name: 'Bash',
                input: { command: 'old autonomous command' },
              },
            ],
          },
        })
        finish()
        continue
      }
      if (scenario === 'callback-observed-owner') {
        emit({
          type: 'assistant',
          uuid: 'native-owned-envelope',
          user_message_uuid: inputUuid,
          message: {
            id: 'native-owned-api',
            content: [{ type: 'tool_use', id: 'native-owned-tool', name: 'Bash', input: { command: 'owned command' } }],
          },
        })
        await new Promise((resolve) => setImmediate(resolve))
        await options.canUseTool(
          'Bash',
          { command: 'owned command' },
          {
            requestId: 'native-owned-request',
            toolUseID: 'native-owned-tool',
            suggestions: [],
            signal: new AbortController().signal,
          },
        )
        finish()
        continue
      }
      if (scenario === 'stream') {
        const partial = (event) => emit({ type: 'stream_event', event, parent_tool_use_id: null })
        emit({
          type: 'stream_event',
          user_message_uuid: inputUuid,
          event: { type: 'message_start', message: { id: 'native-text', content: [] } },
        })
        partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } })
        partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } })
        partial({ type: 'content_block_stop', index: 0 })
        partial({ type: 'message_stop' })
        emitText('native-text', 'Hello world')
        finish()
      } else if (scenario === 'foreign') {
        emitText('native-foreign', 'autonomous output', 'foreign-input')
        finish('foreign-input')
        emitText('native-current', 'current output')
        finish()
      } else if (scenario === 'rows') {
        emitText('native-answer', 'Distinct answer')
        emit({
          type: 'assistant',
          user_message_uuid: inputUuid,
          message: {
            id: 'native-tools',
            content: [{ type: 'tool_use', id: 'native-call', name: 'Read', input: { file_path: 'a.txt' } }],
          },
        })
        emit({
          type: 'user',
          uuid: 'native-result-envelope',
          message: { content: [{ type: 'tool_result', tool_use_id: 'native-call', content: 'file contents' }] },
        })
        finish()
      } else if (scenario === 'child-lifecycle') {
        emit({
          type: 'assistant',
          uuid: 'native-agent-envelope',
          user_message_uuid: inputUuid,
          message: {
            id: 'native-agent-api',
            content: [
              {
                type: 'tool_use',
                id: 'native-agent-tool',
                name: 'Agent',
                input: { description: 'Inspect', prompt: 'Inspect', run_in_background: true },
              },
            ],
          },
        })
        emit({
          type: 'system',
          subtype: 'task_started',
          task_type: 'local_agent',
          task_id: 'native-child',
          tool_use_id: 'native-agent-tool',
          description: 'Inspect',
        })
        emit({
          type: 'assistant',
          parent_tool_use_id: 'native-agent-tool',
          uuid: 'child-private-envelope',
          message: { id: 'child-api', content: [{ type: 'text', text: 'Child transcript stays separate' }] },
        })
        emit({
          type: 'system',
          subtype: 'task_progress',
          task_id: 'native-child',
          tool_use_id: 'native-agent-tool',
          summary: 'Inspecting',
        })
        emit({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'native-child',
          tool_use_id: 'stale-tool',
          status: 'failed',
          summary: 'stale',
        })
        emit({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'native-child',
          tool_use_id: 'native-agent-tool',
          status: 'completed',
          summary: 'Complete',
        })
        finish()
      } else if (scenario.startsWith('callback')) {
        const controller = new AbortController()
        if (scenario === 'callback-already-aborted') controller.abort()
        const answer = options.canUseTool(
          'Bash',
          { command: 'echo safe' },
          { requestId: 'native-request', toolUseID: 'native-tool', suggestions: [], signal: controller.signal },
        )
        if (scenario === 'callback-withdraw') setImmediate(() => controller.abort())
        const reply = await answer
        if (scenario === 'callback-answer-abort') controller.abort()
        emitText('native-reply', JSON.stringify(reply))
        finish()
      } else if (scenario === 'overflow') {
        emitText('native-overflow', 'x'.repeat(8192))
        finish()
      } else if (scenario === 'mcp') {
        emitText('native-mcp', JSON.stringify(options.mcpServers))
        finish()
      } else if (scenario === 'interrupt') {
        /* Wait for native interrupt. */
      } else {
        emitText('native-default', 'ok')
        finish()
      }
    }
  })
  return instance
}
