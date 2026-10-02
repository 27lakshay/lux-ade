// The generic ACP provider worker (F024). The runtime starts it for an `adapter:<id>` definition
// of kind `acp` with ADE_ACP_AGENT = {name, command, args, env}. It launches that agent, speaks
// Agent Client Protocol v1 to it through the official ACP SDK, and serves ADE's public provider
// worker protocol through `@ade/provider-sdk`.
//
// Negotiation happens before this worker answers its own `initialize`: the descriptor declares
// only what the agent declared. A version mismatch or failed negotiation leaves open and send
// unavailable with the reason, so it is reported before any session or prompt exists.
import { readFileSync } from 'node:fs'
import { Cause, Effect, Layer, Queue, Stream } from 'effect'
import { runProviderWorker } from '@ade/provider-sdk/node'
import { agentFailure, acp, startAgent } from './session.mjs'
import {
  ReplayCapture,
  Tools,
  TurnMapper,
  bounded,
  cancelledOutcome,
  failure,
  initializeRequest,
  negotiate,
  permissionOptions,
  permissionOutcome,
  permissionRequest,
  promptBlocks,
} from './normalize.mjs'

const agentConfig = JSON.parse(process.env.ADE_ACP_AGENT ?? 'null')
if (!agentConfig || typeof agentConfig.command !== 'string')
  throw new Error('The owning ADE runtime must provide the ACP agent definition')
const workerVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const INITIALIZE_MS = 10_000
const WRITE_MS = 5_000
const CLOSE_MS = 1_500
const SESSION_ID = 256
const QUEUE_ENTRIES = 256
const QUEUE_BYTES = 16 * 1024 * 1024
// Above these, the worker stops reading the agent until ADE drains its events.
const HOLD_ENTRIES = 32
const HOLD_BYTES = 4 * 1024 * 1024

const events = Effect.runSync(Queue.dropping(QUEUE_ENTRIES))
let queuedBytes = 0
let active = true
let closing = false
let waiting = []
const roomy = () => Queue.sizeUnsafe(events) < HOLD_ENTRIES && queuedBytes < HOLD_BYTES
const room = () => (roomy() ? undefined : new Promise((resolve) => waiting.push(resolve)))

function failWorker(detail) {
  if (!active) return
  active = false
  Queue.failCauseUnsafe(events, Cause.fail(detail))
  for (const resolve of waiting.splice(0)) resolve()
}

function emit(event) {
  if (!active) return
  const bytes = Buffer.byteLength(JSON.stringify(event)) + 64
  if (queuedBytes + bytes > QUEUE_BYTES || !Queue.offerUnsafe(events, { event, bytes })) {
    failWorker(failure('resource_limit', 'ACP worker events exceeded their retained byte or entry budget'))
    return
  }
  queuedBytes += bytes
}

/** Emits in order, waiting for room between events, so a burst holds the agent instead of failing. */
async function emitAll(list) {
  for (const event of list) {
    const wait = room()
    if (wait) await wait
    emit(event)
  }
}

// --- Native state, in wire order --------------------------------------------------------------
let session = null
let capture = null
let currentTurn = null
let features = new Set()
const tools = new Tools()
/** Outgoing requests whose reply changes state, by JSON-RPC ID. */
const outgoing = new Map()
/** Permission requests waiting for an ADE answer, by native request ID. */
const permissions = new Map()
const permissionKey = (id) => JSON.stringify(id)
let pendingPrompt = null
let pendingNew = false
let ignored = 0

const ACCEPTING = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
])

function accept(turn) {
  if (turn.accepted) return []
  turn.accepted = true
  return [
    {
      type: 'submitted',
      submission: turn.submission,
      turn: null,
      admitted: true,
      dispatch: 'dispatched',
      native_outcome: 'accepted',
    },
  ]
}

function onOutgoing(message) {
  if (!message || typeof message !== 'object' || !('method' in message) || !('id' in message)) return
  if (message.method === 'session/prompt' && pendingPrompt) {
    const turn = pendingPrompt
    pendingPrompt = null
    turn.requestId = message.id
    outgoing.set(message.id, { kind: 'prompt', turn })
    // Bound before dispatch: Started precedes every update the agent can send for this prompt.
    emit({ type: 'started', session, submission: turn.submission, turn: null })
    turn.written()
  } else if (message.method === 'session/load' && capture) {
    outgoing.set(message.id, { kind: 'load', capture })
  } else if (message.method === 'session/new' && pendingNew) {
    pendingNew = false
    outgoing.set(message.id, { kind: 'new' })
  }
}

function onIncoming(message) {
  if (!message || typeof message !== 'object') return undefined
  if ('method' in message) {
    if (message.method !== 'session/update' || 'id' in message) return undefined
    return update(message.params)
  }
  const pending = outgoing.get(message.id)
  if (!pending) return undefined
  outgoing.delete(message.id)
  if (pending.kind === 'prompt') return finishTurn(pending.turn, message)
  if (pending.kind === 'load') {
    // The drain barrier: every update before this reply was replay; everything after is live.
    pending.capture.closed = true
    pending.capture.failed = 'error' in message
    if (!pending.capture.failed) session = pending.capture.session
    if (capture === pending.capture) capture = null
  } else if (pending.kind === 'new' && !('error' in message)) {
    const id = bounded(message.result?.sessionId, SESSION_ID)
    if (id) session = id
  }
  return room()
}

function update(params) {
  if (!active || !params || typeof params !== 'object') return undefined
  const kind = params.update?.sessionUpdate
  if (capture && !capture.closed && params.sessionId === capture.session) {
    capture.capture(params.update)
    return room()
  }
  if (!session || params.sessionId !== session) {
    ignored++
    return undefined
  }
  const turn = currentTurn
  try {
    if (turn && turn.requestId !== undefined && !turn.done) {
      const list = [...(ACCEPTING.has(kind) ? accept(turn) : []), ...turn.mapper.update(params.update)]
      return emitAll(list)
    }
    // No prompt is open: only identified tool state may update; text cannot join an unrelated turn.
    if (kind === 'tool_call' || kind === 'tool_call_update')
      return emitAll([
        { type: 'item', session, submission: null, item: tools.update(params.update, kind === 'tool_call') },
      ])
  } catch (error) {
    failWorker(error?.code ? error : failure('invalid_request', 'The ACP agent sent a malformed session update'))
    return undefined
  }
  ignored++
  return undefined
}

function settlePermission(entry, outcome) {
  if (!permissions.has(entry.key)) return
  permissions.delete(entry.key)
  entry.turn?.permissions.delete(entry)
  entry.resolve(outcome)
}

function withdrawPermissions(turn) {
  const list = []
  // A copy: settling removes the entry from the set being read.
  for (const entry of Array.from(turn.permissions)) {
    settlePermission(entry, cancelledOutcome())
    list.push({ type: 'resolved', id: entry.id, session, submission: turn.submission, resolution: 'withdrawn' })
  }
  return list
}

function finishTurn(turn, message) {
  if (turn.done) return undefined
  turn.done = true
  if (currentTurn === turn) currentTurn = null
  const list = withdrawPermissions(turn)
  if ('error' in message) {
    const detail = String(message.error?.message ?? 'unknown error').slice(0, 512)
    if (!turn.accepted)
      list.push({
        type: 'submitted',
        submission: turn.submission,
        turn: null,
        admitted: true,
        dispatch: 'dispatched',
        native_outcome: 'rejected',
      })
    list.push(
      ...turn.mapper.finish({
        error: `The ACP agent refused the prompt: ${detail}`,
        interruptRequested: turn.cancelRequested,
      }),
    )
  } else {
    list.push(...accept(turn))
    list.push(...turn.mapper.finish({ result: message.result, interruptRequested: turn.cancelRequested }))
  }
  return emitAll(list)
}

async function onPermission({ params, requestId, signal }) {
  if (!active || !session || params.sessionId !== session || !permissionOptions(params.options))
    throw acp.RequestError.invalidParams(undefined, 'ADE cannot present this permission request')
  const turn = currentTurn && currentTurn.requestId !== undefined && !currentTurn.done ? currentTurn : null
  // A request after Stop is answered as the protocol requires for a cancelled turn.
  if (turn?.cancelRequested) return cancelledOutcome()
  return new Promise((resolve, reject) => {
    const entry = { key: permissionKey(requestId), id: requestId, options: params.options, turn, resolve, reject }
    permissions.set(entry.key, entry)
    turn?.permissions.add(entry)
    emit(permissionRequest({ id: requestId, session, submission: turn?.submission ?? null, params }))
    signal.addEventListener(
      'abort',
      () => {
        if (!permissions.has(entry.key)) return
        permissions.delete(entry.key)
        turn?.permissions.delete(entry)
        emit({
          type: 'resolved',
          id: requestId,
          session,
          submission: turn?.submission ?? null,
          resolution: 'withdrawn',
        })
        resolve(cancelledOutcome())
      },
      { once: true },
    )
  })
}

// --- Start the agent and negotiate --------------------------------------------------------------
const agent = startAgent({
  command: agentConfig.command,
  args: Array.isArray(agentConfig.args) ? agentConfig.args : [],
  env: agentConfig.env && typeof agentConfig.env === 'object' ? agentConfig.env : {},
  cwd: process.cwd(),
  onIncoming,
  onOutgoing,
  onPermission,
  onExit: ({ code, signal, error, stderrBytes }) => {
    if (closing) return
    const how = error ? `could not start (${error})` : signal ? `stopped by ${signal}` : `exited with status ${code}`
    // An exit never settles a turn: the run ends with the outcome of any running prompt unknown.
    failWorker(
      failure('transport_failure', `The ACP agent ${how}; ${stderrBytes} bytes of agent diagnostics were drained`),
    )
  },
})

let init = null
let problem = null
try {
  init = await Promise.race([
    agent.agent.request('initialize', initializeRequest(workerVersion)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`no reply within ${INITIALIZE_MS / 1000} seconds`)), INITIALIZE_MS).unref(),
    ),
  ])
} catch (error) {
  problem = `The ACP agent did not complete initialize: ${String(error?.message ?? error).slice(0, 400)}`
}
const negotiated = negotiate({ name: agentConfig.name || 'ACP agent', init, problem })
features = negotiated.features
if (negotiated.problem) {
  // Nothing may run on an agent this worker cannot speak to; the descriptor reports why.
  closing = true
  await agent.stop(CLOSE_MS)
}

const timeout = (ms, label) =>
  new Promise((_, reject) => setTimeout(() => reject(failure('timeout', label)), ms).unref())

const request = (method, params, fallback) =>
  agent.agent.request(method, params).catch((error) => {
    throw agentFailure(error, fallback)
  })

const open = async (params) => {
  if (negotiated.problem) throw failure('protocol_mismatch', negotiated.problem)
  if (session || capture) throw failure('invalid_request', 'The ACP session is already open')
  const config = params.config ?? {}
  if ((config.permission_mode ?? 'default') !== 'default' || config.model)
    throw failure('unsupported', 'Generic ACP adapters declare no model or permission-mode options')
  const cwd = process.cwd()
  if (!params.resume) {
    pendingNew = true
    const result = await request('session/new', { cwd, mcpServers: [] }, 'The ACP agent did not create a session')
    const id = bounded(result?.sessionId, SESSION_ID)
    if (!id) throw failure('provider_failure', 'The ACP agent returned no usable session ID')
    session = id
    return { session, history: [] }
  }
  const resume = params.resume
  if (features.has('resume_session')) {
    // Restores the session without replay; ADE already holds this Conversation's transcript.
    await request(
      'session/resume',
      { sessionId: resume, cwd, mcpServers: [] },
      'The ACP agent did not resume the session',
    )
    session = resume
    return { session, history: [] }
  }
  if (features.has('load_session')) {
    capture = new ReplayCapture(resume)
    const own = capture
    try {
      await request(
        'session/load',
        { sessionId: resume, cwd, mcpServers: [] },
        'The ACP agent did not load the session',
      )
    } catch (error) {
      if (capture === own) capture = null
      throw error
    }
    if (!own.closed || own.failed)
      throw failure('integration_bug', 'The ACP load reply passed without its replay barrier')
    session = resume
    return { session, history: own.history({ maxItems: 32, maxBytes: 448 * 1024 }) }
  }
  throw failure('unsupported', 'This ACP agent declared neither session/load nor session/resume')
}

const send = async (params) => {
  if (!session || params.session !== session) throw failure('invalid_request', 'The ACP session is not open')
  if (currentTurn)
    throw failure('invalid_request', 'A prompt is already running; ACP admits one prompt per session at a time')
  const blocks = promptBlocks(params.text, params.attachments, features)
  let written
  const writtenSignal = new Promise((resolve) => {
    written = resolve
  })
  const turn = {
    submission: params.submission,
    attempt: params.source_attempt_id,
    mapper: new TurnMapper({ session, submission: params.submission, tools }),
    requestId: undefined,
    accepted: false,
    done: false,
    cancelRequested: false,
    permissions: new Set(),
    written,
  }
  currentTurn = turn
  pendingPrompt = turn
  const reply = agent.agent.request('session/prompt', { sessionId: session, prompt: blocks })
  // The turn ends from the reply observed in wire order (onIncoming); this only covers a prompt
  // the SDK refused before it reached the agent.
  const refused = reply.then(
    () => undefined,
    (error) => error,
  )
  const first = await Promise.race([
    writtenSignal.then(() => 'written'),
    refused,
    timeout(WRITE_MS, 'write').catch(() => 'slow'),
  ])
  if (turn.requestId === undefined) {
    if (pendingPrompt === turn) pendingPrompt = null
    if (first === 'slow')
      // Still queued for the agent: it may yet run, so the outcome is unknown, not refused.
      return { admitted: true, dispatch: 'pending', native_outcome: 'unknown', turn: null }
    if (currentTurn === turn) currentTurn = null
    throw agentFailure(first, 'The prompt did not reach the ACP agent. Nothing was sent')
  }
  return { admitted: true, dispatch: 'dispatched', native_outcome: 'pending', turn: null }
}

const cancel = async (params) => {
  if (!session || params.session !== session || params.turn != null)
    throw failure('invalid_request', 'ACP cancellation targets its open session with no fabricated native turn')
  const turn = currentTurn
  if (!turn || turn.submission !== params.submission_id || turn.attempt !== params.source_attempt_id)
    throw failure('invalid_request', 'ACP cancellation does not match the running prompt of this attempt')
  turn.cancelRequested = true
  // The protocol requires open permission requests of a cancelled turn to be answered `cancelled`.
  await emitAll(withdrawPermissions(turn))
  try {
    await agent.agent.notify('session/cancel', { sessionId: session })
  } catch (error) {
    throw agentFailure(error, 'session/cancel did not reach the ACP agent')
  }
  return {
    type: 'cancel_result',
    evidence: {
      scope: 'turn',
      interruption_requested: true,
      // Confirmed only by the prompt's own reply, reported as its finished event.
      termination: 'requested',
      active_work_remaining: turn.done ? false : null,
      queued_work_count: 0,
      background_work_remaining: null,
      observed_at_ms: null,
    },
  }
}

const answer = (params) => {
  const entry = permissions.get(permissionKey(params.id))
  if (!entry) throw failure('invalid_request', 'This ACP permission request is no longer pending')
  if (params.reason) {
    permissions.delete(entry.key)
    entry.turn?.permissions.delete(entry)
    entry.reject(
      new acp.RequestError(-32603, `ADE refused this permission request: ${String(params.reason).slice(0, 256)}`),
    )
  } else settlePermission(entry, permissionOutcome(entry.options, params.answer))
  emit({ type: 'resolved', id: entry.id, session, submission: entry.turn?.submission ?? null, resolution: 'resolved' })
  return {}
}

const close = async () => {
  closing = true
  const running = currentTurn && !currentTurn.done
  if (session && running) {
    // Close cancels running work as session/cancel would; neither settles the turn here.
    if (features.has('close_session'))
      await Promise.race([
        agent.agent.request('session/close', { sessionId: session }),
        timeout(CLOSE_MS, 'close'),
      ]).catch(() => {})
    else await agent.agent.notify('session/cancel', { sessionId: session }).catch(() => {})
  }
  for (const entry of Array.from(permissions.values())) settlePermission(entry, cancelledOutcome())
  active = false
  for (const resolve of waiting.splice(0)) resolve()
  if (ignored) process.stderr.write(`ACP worker ignored ${ignored} unattributed session updates\n`)
  await agent.stop(CLOSE_MS)
}

const effect = (run, fallback) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error?.code
        ? error
        : failure('provider_failure', `${fallback}: ${String(error?.message ?? error).slice(0, 256)}`),
  })

runProviderWorker({
  descriptor: negotiated.descriptor,
  dependencies: Layer.empty,
  acquire: Effect.succeed({
    open: (params) => effect(() => open(params), 'The ACP session did not open'),
    send: (params) => effect(() => send(params), 'The ACP prompt failed'),
    steer: () => Effect.fail(failure('unsupported', 'ACP v1 has no method to steer a running prompt turn')),
    cancel: (params) => effect(() => cancel(params), 'ACP cancellation failed'),
    answer: (params) => effect(async () => answer(params), 'The ACP permission answer failed'),
    history: () => Effect.fail(failure('unsupported', 'ACP v1 has no read-only history query')),
    events: Stream.map(Stream.fromQueue(events), (entry) => {
      queuedBytes -= entry.bytes
      if (roomy()) for (const resolve of waiting.splice(0)) resolve()
      return entry.event
    }),
    close: effect(close, 'The ACP agent did not stop'),
  }),
})
