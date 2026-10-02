// Desktop E2E fixture provider worker (docs/provider-worker-protocol.md, version 2). Every turn
// answers with an `e2e.ui.card` item: canonical text plus an extension payload the fixture UI
// renders. A prompt containing "fail" asks the renderer to throw; one containing "hold" keeps the
// turn running until it is cancelled. It calls no model.
import { createInterface } from 'node:readline'

const history = []
let session = null
let turns = 0
/** The held turn, waiting for `cancel`. */
let held = null

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function event(params) {
  write({ method: 'event', params })
}

const operation = (method, tier) => ({ method, tier, availability: 'available', reason: '' })
const unsupported = (method, tier, reason) => ({ method, tier, availability: 'unsupported', reason })

const methods = {
  initialize: () => ({
    protocol_version: 2,
    compatible_protocol_versions: [2],
    name: 'E2E UI agent',
    capabilities: [
      { name: 'streaming', support: 'supported', available: true, reason: '' },
      { name: 'resume', support: 'supported', available: true, reason: '' },
      { name: 'cancel', support: 'supported', available: true, reason: '' },
    ],
    permission_modes: ['default'],
    operations: [
      operation('initialize', 'query'),
      operation('open', 'effect_command'),
      operation('send', 'effect_command'),
      unsupported('steer', 'effect_command', 'Fixture does not support steering'),
      operation('cancel', 'idempotent_command'),
      operation('answer', 'effect_command'),
      unsupported('history', 'query', 'Fixture does not expose paged history'),
    ],
    limits: {
      max_input_frame_bytes: 1048576,
      max_input_entries: 1024,
      max_initialize_ms: 15000,
      max_output_frame_bytes: 1048576,
      max_history_page_items: 32,
      max_output_entries: 32,
      max_concurrency: 8,
      max_partial_frame_ms: 10000,
      max_operation_ms: 45000,
      max_cleanup_ms: 5000,
    },
    requirements: {
      sdk_api_version: 2,
      sdk_version: '0.2.0',
      effect_version: '4.0.0-rc.118',
      platform_node_version: '4.0.0-rc.118',
      node_engine: '>=22',
    },
  }),
  open: (params) => {
    session = params.resume ?? `e2e-ui-session-${process.pid}`
    return { session, history }
  },
  send: (params) => {
    const turn = `turn-${process.pid}-${++turns}`
    const text = String(params.text ?? '')
    const user = {
      id: params.message_id ?? `${turn}-user`,
      client_id: params.submission ?? null,
      turn,
      role: 'user',
      kind: 'text',
      text,
      status: 'completed',
    }
    const card = {
      id: `${turn}-card`,
      client_id: null,
      turn,
      role: 'assistant',
      kind: 'e2e.ui.card',
      text: 'Check summary: 3 checks passed.',
      status: 'completed',
      // `partial` sends a payload without the declared `passed` field.
      content: {
        type: 'extension',
        data: text.includes('partial')
          ? { title: 'Checks' }
          : { title: 'Checks', passed: 3, fail: text.includes('fail') },
      },
    }
    history.push(user, card)
    setImmediate(() => {
      event({
        type: 'submitted',
        submission: params.submission,
        turn,
        admitted: true,
        dispatch: 'dispatched',
        native_outcome: 'accepted',
      })
      event({ type: 'started', session, submission: params.submission, turn })
      event({ type: 'item', session, submission: params.submission, item: user })
      event({ type: 'item', session, submission: params.submission, item: card })
      if (text.includes('hold')) held = { submission: params.submission, turn }
      else event({ type: 'finished', session, submission: params.submission, turn, status: 'completed', error: null })
    })
    return { turn, admitted: true, dispatch: 'dispatched', native_outcome: 'accepted' }
  },
  cancel: () => {
    const target = held
    held = null
    if (target) {
      setImmediate(() =>
        event({
          type: 'finished',
          session,
          submission: target.submission,
          turn: target.turn,
          status: 'interrupted',
          error: null,
        }),
      )
    }
    return {
      type: 'cancel_result',
      evidence: {
        scope: 'turn',
        interruption_requested: target !== null,
        termination: 'requested',
        active_work_remaining: null,
        queued_work_count: 0,
        background_work_remaining: null,
      },
    }
  },
  answer: () => ({}),
}

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    if (!line.trim()) return
    const message = JSON.parse(line)
    const handler = methods[message.method]
    if (!handler) {
      write({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
      return
    }
    write({ id: message.id, result: handler(message.params ?? {}) })
  })
  .on('close', () => process.exit(0))
