// Deterministic Claude Agent SDK double for worker unit tests and protocol tests. The
// worker loads it in place of @anthropic-ai/claude-agent-sdk when ADE_E2E_CLAUDE_SDK names
// it. Never imports Claude or calls a model. Session storage and the session functions
// live in worker-test-store.mjs.
//
// It keeps the native correlation the worker relies on: the user echo carries the input
// UUID, output and results name it in user_message_uuid, and a tool's assistant tool_use
// arrives before its canUseTool callback. The first text block of each input selects a
// scenario; any other text gets the plain reply "Hello Claude".
import { randomUUID } from 'node:crypto'
import { fixtureChild, load, promptText, record, writer } from './worker-test-store.mjs'
import { scripted } from './worker-test-scenarios.mjs'

export {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
} from './worker-test-store.mjs'

// resumeSessionAt loads the chain only up to that entry. With resumeDropsTurn the
// discarded range must be exactly that one turn, or the CLI refuses the resume, as
// sdk.d.ts documents. An entry the session absorbed mid-turn (a task notification) is
// not from that turn.
function truncation(history, options) {
  if (!options.resumeSessionAt) return { rejected: false, context: history }
  const at = history.findIndex((entry) => entry.uuid === options.resumeSessionAt)
  const dropped = history.slice(at + 1)
  const rejected =
    at < 0 ||
    (!!options.resumeDropsTurn &&
      (dropped[0]?.uuid !== options.resumeDropsTurn ||
        dropped.slice(1).some((entry) => promptText(entry) !== null || entry.absorbed)))
  return { rejected, context: rejected ? history : history.slice(0, at + 1) }
}

// The ModelInfo rows initializationResult() and supportedModels() list: effort levels
// differ by model, and one model takes no effort at all.
export const fixtureModels = [
  {
    value: 'default',
    resolvedModel: 'fixture-sonnet',
    displayName: 'Default (Fixture Sonnet)',
    description: 'Fixture default',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    value: 'fixture-opus',
    resolvedModel: 'fixture-opus',
    displayName: 'Fixture Opus',
    description: 'Fixture model with every effort level',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'fixture-haiku',
    resolvedModel: 'fixture-haiku',
    displayName: 'Fixture Haiku',
    description: 'Fixture model without effort',
    supportsEffort: false,
  },
]

export function query({ prompt, options }) {
  // A forking resume runs under a new session ID and leaves the source unchanged. Its file
  // is written only with its first new message: nothing may rely on an idle fork.
  const fork = !!(options.resume && options.forkSession)
  const session = fork
    ? (options.sessionId ?? randomUUID())
    : (options.resume ?? options.sessionId ?? 'fixture-session')
  const source = options.resume ? (load(options.resume) ?? []) : []
  const { rejected, context } = truncation(source, options)
  // A non-forking truncating resume never truncates the file: what the CLI does to it is undocumented.
  const history = fork ? [...context] : [...source]
  const servers = Object.keys(options.mcpServers ?? {}).length ? options.mcpServers : null
  // Recorded only for a catalog, fork or truncating launch, so other call logs stay unchanged.
  if (servers || options.resumeSessionAt || fork)
    record({
      method: 'query',
      session,
      resume: options.resume ?? null,
      ...(servers ? { mcpServers: servers } : {}),
      ...(fork ? { forkSession: true } : {}),
      ...(options.resumeSessionAt
        ? { resumeSessionAt: options.resumeSessionAt, resumeDropsTurn: options.resumeDropsTurn ?? null, rejected }
        : {}),
    })
  const save = writer(session, { source: options.resume ?? null, fork, cwd: options.cwd })
  if (!fork && !options.resume) save(history)

  const messages = []
  let wake = null,
    closed = false,
    ending = false
  const emit = (message) => {
    const entry = { session_id: session, ...message }
    if (entry.type === 'user' || entry.type === 'assistant') {
      history.push(entry)
      save(history)
    }
    messages.push(entry)
    wake?.()
    wake = null
  }
  const turn = {
    session,
    options,
    emit,
    // A session entry the CLI keeps but never reports, such as an absorbed task notification.
    keep: (entry) => {
      history.push(entry)
      save(history)
    },
    // Cumulative per query() call, as the SDK reports modelUsage and total_cost_usd.
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 },
    input: null,
    interrupt: null,
    child: fixtureChild,
  }
  const initialized = Promise.resolve().then(() => {
    if (process.env.CLAUDE_WORKER_SCENARIO === 'init-failure') throw new Error('native initialization refused')
    // Like the SDK subprocess transport, init names the model and permission mode but not effort.
    emit({
      type: 'system',
      subtype: 'init',
      session_id: process.env.CLAUDE_WORKER_SCENARIO === 'resume-mismatch' ? 'foreign-session' : session,
      model:
        fixtureModels.find((model) => model.value === (options.model ?? 'default'))?.resolvedModel ?? options.model,
      permissionMode: options.permissionMode ?? 'default',
    })
    // Recorded only for an effort launch, so other call logs stay unchanged.
    if (options.effort) record({ method: 'launch', session, model: options.model ?? null, effort: options.effort })
    return {
      commands: [],
      agents: [],
      models: fixtureModels,
      account: {},
      output_style: 'default',
      available_output_styles: [],
    }
  })
  // The reader must consume native init concurrently with the control handshake.
  initialized.catch(() => {})
  // The CLI refuses a rejected resume at boot, and its stream then ends.
  if (rejected)
    queueMicrotask(() => {
      emit({
        type: 'result',
        is_error: true,
        subtype: 'error_during_execution',
        errors: [
          `Resume rejected by --resume-drops-turn: entries after ${options.resumeSessionAt} are not all from ${options.resumeDropsTurn}`,
        ],
      })
      ending = true
    })
  const instance = {
    initializationResult: () => initialized,
    interrupt: async () => (turn.interrupt ? turn.interrupt() : { still_queued: [] }),
    close() {
      closed = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (messages.length) {
          yield messages.shift()
          continue
        }
        if (ending) return
        await new Promise((resolve) => {
          wake = resolve
        })
      }
    },
  }
  queueMicrotask(async () => {
    for await (const input of prompt) {
      if (closed || ending) break
      turn.input = input
      turn.interrupt = null
      const content = input.message.content
      const text = typeof content === 'string' ? content : (content.find((block) => block.type === 'text')?.text ?? '')
      record({ method: 'send', uuid: input.uuid, text, content })
      await scripted(turn, text)
    }
  })
  return instance
}
