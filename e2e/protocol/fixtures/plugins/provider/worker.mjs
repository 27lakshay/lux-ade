// Protocol E2E fixture provider worker (docs/provider-worker-protocol.md,
// version 2). It answers every turn with "Hello plugin" and keeps its
// transcript in memory. It calls no model.
import { createInterface } from 'node:readline'

const history = []
let session = null
let turns = 0

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function event(params) {
  write({ method: 'event', params })
}

const methods = {
  initialize: () => ({
    protocol_version: 2,
    compatible_protocol_versions: [2],
    name: 'E2E agent',
    capabilities: [
      { name: 'streaming', support: 'supported', available: true, reason: '' },
      { name: 'resume', support: 'supported', available: true, reason: '' },
      { name: 'cancel', support: 'supported', available: true, reason: '' },
    ],
    permission_modes: ['default'],
    operations: [
      { method: 'initialize', tier: 'query', availability: 'available', reason: '' },
      { method: 'open', tier: 'effect_command', availability: 'available', reason: '' },
      { method: 'send', tier: 'effect_command', availability: 'available', reason: '' },
      {
        method: 'steer',
        tier: 'effect_command',
        availability: 'unsupported',
        reason: 'Fixture does not support steering',
      },
      { method: 'cancel', tier: 'idempotent_command', availability: 'available', reason: '' },
      { method: 'answer', tier: 'effect_command', availability: 'available', reason: '' },
      {
        method: 'history',
        tier: 'query',
        availability: 'unsupported',
        reason: 'Fixture does not expose paged history',
      },
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
    session = params.resume ?? `e2e-session-${process.pid}`
    return { session, history }
  },
  send: (params) => {
    const turn = `turn-${process.pid}-${++turns}`
    const user = {
      id: params.message_id ?? `${turn}-user`,
      client_id: params.submission ?? null,
      turn,
      role: 'user',
      kind: 'text',
      text: params.text,
      status: 'completed',
    }
    const reply = {
      id: `${turn}-assistant`,
      client_id: null,
      turn,
      role: 'assistant',
      kind: 'text',
      text: 'Hello plugin',
      status: 'completed',
    }
    history.push(user, reply)
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
      event({ type: 'item', session, submission: params.submission, item: reply })
      event({ type: 'finished', session, submission: params.submission, turn, status: 'completed', error: null })
    })
    return { turn, admitted: true, dispatch: 'dispatched', native_outcome: 'accepted' }
  },
  cancel: () => ({}),
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
