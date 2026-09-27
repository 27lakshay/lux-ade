// Protocol E2E fixture provider worker (docs/provider-worker-protocol.md,
// version 1). It answers every turn with "Hello plugin" and keeps its
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
    protocol_version: 1,
    name: 'E2E agent',
    capabilities: ['streaming', 'resume', 'cancel'],
    permission_modes: ['default'],
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
      event({ type: 'submitted', submission: params.submission, turn })
      event({ type: 'started', session, turn })
      event({ type: 'item', session, item: user })
      event({ type: 'item', session, item: reply })
      event({ type: 'finished', session, turn, status: 'completed', error: null })
    })
    return { turn }
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
