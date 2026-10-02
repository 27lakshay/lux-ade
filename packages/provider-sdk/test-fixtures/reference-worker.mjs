// A small provider worker that speaks the worker protocol by hand, without the SDK runner, so the
// conformance harness's own tests can break one behaviour at a time. It conforms by default;
// ADE_CONFORMANCE_FAULTS (comma-separated) selects faults, each named for the check it breaks.
// Prompts: `hello` completes, `hold` runs until cancelled, `ask` requests an approval.
// REFERENCE_WORKER_DIR keeps sessions (for resume) and `prompts.jsonl`, the native prompt record.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DEFAULT_LIMITS, SDK_REQUIREMENTS } from '../dist/index.js'

const faults = new Set((process.env.ADE_CONFORMANCE_FAULTS ?? '').split(',').filter(Boolean))
const dir = process.env.REFERENCE_WORKER_DIR
if (!dir) throw new Error('REFERENCE_WORKER_DIR is required')
mkdirSync(dir, { recursive: true })

const limits = { ...DEFAULT_LIMITS, max_output_frame_bytes: 64 * 1024, max_partial_frame_ms: 1_000 }
const operation = (method, tier, available, reason = '') => ({
  method,
  tier,
  availability: available ? 'available' : 'unsupported',
  reason: available ? '' : reason || 'The reference worker does not implement this operation',
})
const descriptor = {
  protocol_version: 2,
  compatible_protocol_versions: [2],
  name: 'Reference worker',
  capabilities: [],
  permission_modes: ['default'],
  operations: [
    operation('initialize', 'query', true),
    operation('open', 'effect_command', true),
    operation('send', 'effect_command', true),
    operation('steer', 'effect_command', false),
    operation('cancel', 'idempotent_command', true),
    operation('answer', 'effect_command', true),
    operation('history', 'query', false),
    operation('compact', 'effect_command', faults.has('missing-handler')),
    operation('rewind', 'effect_command', false),
  ],
  limits,
  requirements: faults.has('descriptor') ? { ...SDK_REQUIREMENTS, sdk_version: '0.1.0' } : SDK_REQUIREMENTS,
}

const write = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const refuse = (id, code, message, rpc = -32000) =>
  write({
    jsonrpc: '2.0',
    id,
    error: { code: rpc, message: 'Provider worker request failed', data: { code, message } },
  })
const event = (params) => write({ jsonrpc: '2.0', method: 'event', params })

let session = null
const results = new Map() // submission -> send result
const held = new Map() // submission -> true while running
const requests = new Map() // request id -> { submission, choices }
const answered = new Set() // operation IDs
let requestCount = 0

const submissionOf = (submission) => (faults.has('anonymous-events') ? null : submission)
function finished(submission, status, interrupt = false) {
  const value = {
    type: 'finished',
    session,
    submission: submissionOf(submission),
    turn: null,
    status,
    error: null,
    interrupt_requested: interrupt,
  }
  event(value)
  if (faults.has('double-finished')) event(value)
}

function run(submission, text) {
  appendFileSync(join(dir, 'prompts.jsonl'), JSON.stringify({ submission, text }) + '\n')
  event({ type: 'started', session, submission: submissionOf(submission), turn: null })
  event({
    type: 'submitted',
    submission,
    turn: null,
    admitted: true,
    dispatch: 'dispatched',
    native_outcome: 'accepted',
  })
  if (faults.has('invalid-event')) event({ type: 'delta', session })
  if (faults.has('oversized-output'))
    event({
      type: 'delta',
      id: 'big',
      kind: 'text',
      role: 'assistant',
      session,
      submission,
      turn: null,
      text: 'x'.repeat(70_000),
    })
  if (text.includes('hold')) {
    held.set(submission, true)
    event({
      type: 'delta',
      id: `a-${submission}`,
      kind: 'text',
      role: 'assistant',
      session,
      submission: submissionOf(submission),
      turn: null,
      text: 'Working',
    })
    return
  }
  if (text.includes('ask')) {
    const id = `req-${++requestCount}`
    const choices = [
      { label: 'Allow', value: 'allow' },
      { label: 'Deny', value: 'deny' },
    ]
    requests.set(id, { submission, choices })
    held.set(submission, true)
    event({
      type: 'request',
      id,
      method: 'permission',
      params: {},
      session,
      submission,
      supported: true,
      turn: null,
      metadata: {
        blocking: true,
        native_request_id: id,
        schema: { kind: 'choices', choices },
        schema_version: 1,
        summary: 'Run a command',
      },
    })
    return
  }
  event({
    type: 'delta',
    id: `a-${submission}`,
    kind: 'text',
    role: 'assistant',
    session,
    submission: submissionOf(submission),
    turn: null,
    text: 'Hello',
  })
  finished(submission, 'completed')
}

function handle(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      if (!params.versions?.includes(2) && !faults.has('accepts-v1'))
        return refuse(id, 'protocol_mismatch', 'No compatible provider worker protocol version')
      return reply(id, descriptor)
    case 'open': {
      if (params.resume) {
        if (!existsSync(join(dir, `${params.resume}.json`))) return refuse(id, 'invalid_request', 'Unknown session')
        session = faults.has('resume-new-session') ? `ref-${Date.now()}` : params.resume
      } else {
        session = `ref-${process.pid}-${Date.now()}`
        writeFileSync(join(dir, `${session}.json`), '{}')
      }
      return reply(id, { session, history: [] })
    }
    case 'send': {
      if (params.session !== session) return refuse(id, 'invalid_request', 'Session is not open')
      if (results.has(params.submission) && !faults.has('retry-reruns'))
        return reply(id, results.get(params.submission))
      const result = { admitted: true, dispatch: 'dispatched', native_outcome: 'pending', turn: null }
      results.set(params.submission, result)
      reply(id, result)
      return run(params.submission, params.text)
    }
    case 'cancel': {
      if (params.session !== session || !held.has(params.submission_id))
        return refuse(id, 'invalid_request', 'No running turn for that submission')
      const evidence = {
        scope: 'turn',
        interruption_requested: true,
        termination: faults.has('confirmed-cancel') ? 'confirmed' : 'requested',
        active_work_remaining: null,
        queued_work_count: 0,
        background_work_remaining: null,
        observed_at_ms: null,
      }
      reply(id, { type: 'cancel_result', evidence })
      // A worker that claims confirmation without native evidence never sees the turn end.
      if (faults.has('confirmed-cancel')) return
      held.delete(params.submission_id)
      return setTimeout(() => finished(params.submission_id, 'interrupted', true), 20)
    }
    case 'answer': {
      const request = requests.get(params.id)
      if (!request) {
        if (answered.has(params.operation_id) && !faults.has('answer-reapplies')) return reply(id, {})
        return refuse(id, 'invalid_request', 'That request is no longer pending')
      }
      const value = params.answer?.value
      if (!faults.has('accepts-unoffered') && !request.choices.some((choice) => choice.value === value))
        return refuse(id, 'invalid_request', 'The request did not offer that choice')
      if (!faults.has('answer-reapplies')) requests.delete(params.id)
      answered.add(params.operation_id)
      reply(id, {})
      event({ type: 'resolved', id: params.id, session, submission: request.submission, resolution: 'resolved' })
      if (held.delete(request.submission)) finished(request.submission, 'completed')
      return
    }
    case 'compact':
      // Declared available under `missing-handler`, with nothing behind it.
      return refuse(id, 'unsupported', 'Unsupported provider worker method', -32601)
    case 'rewind':
      if (faults.has('unavailable-succeeds')) return reply(id, { session: null })
      return refuse(id, 'unsupported', 'The reference worker does not implement this operation')
    default:
      if (descriptor.operations.some((entry) => entry.method === method))
        return refuse(id, 'unsupported', 'The reference worker does not implement this operation')
      return refuse(id, 'unsupported', 'Unsupported provider worker method', -32601)
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (Buffer.byteLength(line) + 1 > limits.max_input_frame_bytes) {
    if (faults.has('ignores-malformed')) return
    refuse(null, 'resource_limit', 'Input frame exceeds max_input_frame_bytes', -32602)
    return
  }
  let message
  try {
    message = JSON.parse(line)
  } catch {
    if (!faults.has('ignores-malformed')) refuse(null, 'invalid_request', 'Invalid JSON-RPC frame', -32700)
    return
  }
  handle(message)
})
input.on('close', () => {
  if (faults.has('shutdown-settles')) for (const submission of held.keys()) finished(submission, 'completed')
  // Never leave without exiting, unless the fault asks the worker to hang.
  if (faults.has('shutdown-hang')) setInterval(() => {}, 1_000)
})
