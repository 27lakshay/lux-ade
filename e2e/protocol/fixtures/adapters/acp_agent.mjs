#!/usr/bin/env node
// Protocol E2E fixture: a small Agent Client Protocol v1 agent. It speaks
// JSON-RPC 2.0, one message per line, on stdin and stdout, and calls no model.
//
// The prompt text scripts each turn:
// - contains "permission": asks `session/request_permission` with allow once,
//   allow always and reject once options, then replies "Permission <option>"
//   or ends the turn cancelled when the answer is `cancelled`;
// - contains "hold": waits for `session/cancel`, then ends the turn cancelled;
// - contains "crash": exits with status 7 in the middle of the turn;
// - contains "tools": streams a tool call with a large raw input, a plan and a
//   usage update, then replies "Tools done";
// - contains "late": replies "Hello ACP", ends the turn, then sends an
//   unattributed chunk "late text" that belongs to no turn;
// - contains "drain": streams 200 chunks before ending the turn;
// - anything else: streams "Hello " and "ACP" and ends the turn.
// On `session/cancel` a held turn first streams "stopping" (the protocol lets
// an agent finish pending updates) and then ends with stop reason cancelled.
//
// Right after each `session/new` reply it sends "stray startup" text and an
// available-commands update for the new session, before any prompt exists.
// Right after a `session/load` reply it sends "after load" text, which is live
// output and never replay.
//
// ACP_FIXTURE_DIR (required) receives `calls.jsonl`, one line per message
// the agent received, and `sessions/<id>.json`, the history `session/load`
// replays. ACP_FIXTURE_PROTOCOL overrides the protocol version it declares;
// ACP_FIXTURE_RESUME=1 declares `session/resume`, ACP_FIXTURE_CLOSE=1
// declares `session/close`, ACP_FIXTURE_NO_LOAD=1 withdraws `loadSession`,
// ACP_FIXTURE_REPLAY_EXTRA=<n> adds n identified entries to every replay and
// ACP_FIXTURE_ANONYMOUS=1 omits message IDs from replayed chunks.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.env.ACP_FIXTURE_DIR
if (!dir) throw new Error('ACP_FIXTURE_DIR is required')
mkdirSync(join(dir, 'sessions'), { recursive: true })

let nextId = 0
let sessions = 0
const waiting = new Map()
// The running prompt per session: { id, cancelled, onCancel }.
const turns = new Map()

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function record(message) {
  appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ pid: process.pid, ...message })}\n`)
}

function historyPath(session) {
  return join(dir, 'sessions', `${encodeURIComponent(session)}.json`)
}

function history(session) {
  return existsSync(historyPath(session)) ? JSON.parse(readFileSync(historyPath(session), 'utf8')) : []
}

function remember(session, entry) {
  writeFileSync(historyPath(session), JSON.stringify([...history(session), entry]))
}

function update(sessionId, value) {
  write({ method: 'session/update', params: { sessionId, update: value } })
}

function chunk(sessionId, kind, messageId, text) {
  update(sessionId, {
    sessionUpdate: kind,
    ...(messageId === undefined ? {} : { messageId }),
    content: { type: 'text', text },
  })
}

function request(method, params) {
  const id = `agent-${++nextId}`
  write({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}

async function prompt(id, params) {
  const sessionId = params.sessionId
  const text = (params.prompt ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const turn = { cancelled: false, onCancel: null }
  turns.set(sessionId, turn)
  const number = history(sessionId).length + 1
  remember(sessionId, { role: 'user', id: `u-${number}`, text })
  const reply = (textOut) => {
    const messageId = `a-${number}`
    const parts = textOut.length > 1 ? [textOut.slice(0, textOut.length - 3), textOut.slice(-3)] : [textOut]
    for (const part of parts) chunk(sessionId, 'agent_message_chunk', messageId, part)
    remember(sessionId, { role: 'assistant', id: messageId, text: textOut })
  }
  const end = (stopReason) => {
    turns.delete(sessionId)
    write({ id, result: { stopReason } })
  }
  if (text.includes('crash')) {
    process.exit(7)
  }
  if (text.includes('hold')) {
    if (turn.cancelled) return end('cancelled')
    turn.onCancel = () => {
      chunk(sessionId, 'agent_message_chunk', `a-${number}`, 'stopping')
      end('cancelled')
    }
    return
  }
  if (text.includes('tools')) {
    const rawInput = { paths: Array.from({ length: 40 }, (_, index) => `file-${index}.txt`) }
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: `tools-${number}`,
      title: 'Read files',
      kind: 'read',
      status: 'in_progress',
      rawInput,
    })
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read', priority: 'high', status: 'completed' },
        { content: 'Answer', priority: 'medium', status: 'in_progress' },
      ],
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: `tools-${number}`,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'two files' } }],
    })
    update(sessionId, { sessionUpdate: 'usage_update', used: 10, size: 100 })
    reply('Tools done')
    return end('end_turn')
  }
  if (text.includes('drain')) {
    const messageId = `a-${number}`
    for (let index = 0; index < 200; index++) chunk(sessionId, 'agent_message_chunk', messageId, `${index} `)
    remember(sessionId, {
      role: 'assistant',
      id: messageId,
      text: Array.from({ length: 200 }, (_, i) => `${i} `).join(''),
    })
    return end('end_turn')
  }
  if (text.includes('late')) {
    reply('Hello ACP')
    end('end_turn')
    chunk(sessionId, 'agent_message_chunk', undefined, 'late text')
    return
  }
  if (text.includes('permission')) {
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: `call-${number}`,
      title: 'Write notes.txt',
      kind: 'edit',
      status: 'pending',
    })
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: `call-${number}`, title: 'Write notes.txt', kind: 'edit' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const outcome = answer?.outcome ?? {}
    if (outcome.outcome !== 'selected' || turn.cancelled) return end('cancelled')
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: `call-${number}`,
      status: outcome.optionId === 'reject-once' ? 'failed' : 'completed',
    })
    reply(`Permission ${outcome.optionId}`)
    return end('end_turn')
  }
  reply('Hello ACP')
  end('end_turn')
}

const methods = {
  initialize: () => ({
    protocolVersion: Number(process.env.ACP_FIXTURE_PROTOCOL ?? 1),
    agentCapabilities: {
      loadSession: process.env.ACP_FIXTURE_NO_LOAD !== '1',
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: {
        ...(process.env.ACP_FIXTURE_RESUME === '1' ? { resume: {} } : {}),
        ...(process.env.ACP_FIXTURE_CLOSE === '1' ? { close: {} } : {}),
      },
    },
    agentInfo: { name: 'e2e-acp', version: '1.0.0' },
    authMethods: [],
  }),
  'session/new': () => {
    const sessionId = `acp-${process.pid}-${++sessions}`
    writeFileSync(historyPath(sessionId), '[]')
    after.push(() => {
      chunk(sessionId, 'agent_message_chunk', undefined, 'stray startup')
      update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] })
    })
    return { sessionId }
  },
  'session/load': (params) => {
    if (!existsSync(historyPath(params.sessionId))) throw Object.assign(new Error('Unknown session'), { code: -32002 })
    const anonymous = process.env.ACP_FIXTURE_ANONYMOUS === '1'
    const extra = Number(process.env.ACP_FIXTURE_REPLAY_EXTRA ?? 0)
    for (let index = 0; index < extra; index++)
      chunk(params.sessionId, 'agent_message_chunk', anonymous ? undefined : `extra-${index}`, `extra ${index}`)
    for (const entry of history(params.sessionId)) {
      chunk(
        params.sessionId,
        entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
        anonymous ? undefined : entry.id,
        entry.text,
      )
    }
    after.push(() => chunk(params.sessionId, 'agent_message_chunk', undefined, 'after load'))
    return {}
  },
  'session/resume': (params) => {
    if (process.env.ACP_FIXTURE_RESUME !== '1') throw Object.assign(new Error('Method not found'), { code: -32601 })
    if (!existsSync(historyPath(params.sessionId))) throw Object.assign(new Error('Unknown session'), { code: -32002 })
    return {}
  },
  'session/close': (params) => {
    if (process.env.ACP_FIXTURE_CLOSE !== '1') throw Object.assign(new Error('Method not found'), { code: -32601 })
    const turn = turns.get(params.sessionId)
    if (turn) {
      turn.cancelled = true
      turn.onCancel?.()
    }
    return {}
  },
}

// Output sent right after a reply, so it reaches the client after that reply.
const after = []

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    if (!line.trim()) return
    const message = JSON.parse(line)
    record(message)
    if (message.method === undefined) {
      // A reply to a request the agent sent.
      const resolve = waiting.get(message.id)
      waiting.delete(message.id)
      resolve?.(message.result)
      return
    }
    if (message.method === 'session/cancel') {
      const turn = turns.get(message.params?.sessionId)
      if (turn) {
        turn.cancelled = true
        turn.onCancel?.()
      }
      return
    }
    if (message.method === 'session/prompt') {
      prompt(message.id, message.params ?? {}).catch((error) =>
        write({ id: message.id, error: { code: -32603, message: String(error) } }),
      )
      return
    }
    const handler = methods[message.method]
    if (!handler) {
      if (message.id !== undefined)
        write({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
      return
    }
    try {
      write({ id: message.id, result: handler(message.params ?? {}) })
    } catch (error) {
      after.length = 0
      write({ id: message.id, error: { code: error.code ?? -32603, message: error.message } })
    }
    for (const send of after.splice(0)) send()
  })
  .on('close', () => process.exit(0))
