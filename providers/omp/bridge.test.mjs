import { test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from './bridge.mjs'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'ade-omp-bridge-'))
  const events = [],
    entries = [],
    writes = []
  let frame,
    identity,
    stopped = false
  const connect = async (options) => {
    frame = options.onFrame
    const file = options.args[options.args.indexOf('--session') + 1]
    const header = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === 'session')
    identity = {
      sessionId: header.id,
      sessionFile: file,
      isStreaming: false,
      isCompacting: false,
      queuedMessageCount: 0,
    }
    return {
      request: async (type, payload) => {
        if (type === 'get_state') return identity
        if (type === 'get_entries') {
          const start = payload.since ? entries.findIndex((entry) => entry.id === payload.since) + 1 : 0
          return { entries: entries.slice(start), leafId: entries.at(-1)?.id ?? null }
        }
        writes.push({ type, payload })
        return {}
      },
      write: (value) => writes.push(value),
      stop: async () => {
        stopped = true
      },
    }
  }
  const bridge = new Bridge((value) => events.push(value.params), { cwd: directory, directory, connect })
  const opened = await bridge.open({})
  return {
    bridge,
    opened,
    entries,
    events,
    writes,
    connect,
    directory,
    frame: (value) => frame(value),
    stopped: () => stopped,
    close: async () => {
      await bridge.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('owned prompt binds to durable history and completion survives reopening', async () => {
  const h = await harness()
  let reopened
  try {
    const request = { session: h.opened.session, submission: 'ade-message', message_id: 'turn', text: 'hello' }
    await h.bridge.send(request)
    h.entries.push({ id: 'user-entry', parentId: null, type: 'message', message: { role: 'user', content: 'hello' } })
    h.entries.push({
      id: 'assistant-entry',
      parentId: 'user-entry',
      type: 'message',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'reply' }] },
    })
    h.frame({ type: 'message_end' })
    h.frame({ type: 'agent_end', messages: [h.entries[1].message] })
    await h.bridge.events
    expect(h.events.find((e) => e.type === 'item' && e.item.role === 'user').item.client_id).toBe('ade-message')
    expect(h.events.find((e) => e.type === 'finished').status).toBe('completed')
    await h.bridge.close()
    reopened = new Bridge(() => {}, { cwd: h.directory, directory: h.directory, connect: h.connect })
    const result = await reopened.open({ resume: h.opened.session })
    expect(result.session).toBe(h.opened.session)
    expect(result.history.find((item) => item.role === 'user').client_id).toBe('ade-message')
    expect(reopened.active).toBeUndefined()
  } finally {
    await reopened?.close()
    await h.close()
  }
})

test('uncertain submission requires recovery acknowledgement and is not replayed', async () => {
  const h = await harness()
  let reopened
  try {
    await h.bridge.send({ session: h.opened.session, submission: 'ade-message', message_id: 'turn', text: 'hello' })
    await h.bridge.close()
    const events = []
    reopened = new Bridge((value) => events.push(value.params), {
      cwd: h.directory,
      directory: h.directory,
      connect: h.connect,
    })
    await reopened.open({ resume: h.opened.session })
    const recovery = events.find((e) => e.type === 'request')
    expect(recovery.method).toBe('omp/recover')
    expect(h.writes.filter((e) => e.type === 'prompt').length).toBe(1)
    await reopened.answer({ id: recovery.id, decision: 'accept' })
    expect(events.find((e) => e.type === 'finished').status).toBe('interrupted')
    expect(h.writes.filter((e) => e.type === 'prompt').length).toBe(1)
  } finally {
    await reopened?.close()
    await h.close()
  }
})

test('interactive confirmations and questions produce typed RPC responses', async () => {
  const h = await harness()
  try {
    await h.bridge.send({ session: h.opened.session, submission: 'ade-message', message_id: 'turn', text: 'hello' })
    h.frame({
      type: 'extension_ui_request',
      id: 'confirm',
      method: 'confirm',
      title: 'Execute',
      message: 'Allow this?',
    })
    await h.bridge.events
    await h.bridge.answer({ id: 'confirm', decision: 'accept' })
    expect(h.writes.at(-1)).toEqual({ type: 'extension_ui_response', id: 'confirm', confirmed: true })
    h.frame({ type: 'extension_ui_request', id: 'question', method: 'input', title: 'Name?' })
    await h.bridge.events
    await h.bridge.answer({ id: 'question', decision: 'answer', answers: { value: 'lux-ade' } })
    expect(h.writes.at(-1)).toEqual({ type: 'extension_ui_response', id: 'question', value: 'lux-ade' })
    await expect(h.bridge.answer({ id: 'question', decision: 'decline' })).rejects.toThrow('stale')
  } finally {
    await h.close()
  }
})

test('compacted terminal frames retain a previously streamed failure outcome', async () => {
  const h = await harness()
  try {
    await h.bridge.send({ session: h.opened.session, submission: 'ade-message', message_id: 'turn', text: 'hello' })
    h.frame({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'Model failed', content: [] },
    })
    h.frame({ type: 'agent_end', messages: [], messagesOmitted: 1 })
    await h.bridge.events
    const finished = h.events.find((event) => event.type === 'finished')
    expect(finished.status).toBe('failed')
    expect(finished.error).toBe('Model failed')
  } finally {
    await h.close()
  }
})

test('durable history that overtakes queued stream frames cannot regress to a prefix', async () => {
  const h = await harness()
  try {
    await h.bridge.send({ session: h.opened.session, submission: 'ade-message', message_id: 'turn', text: 'hello' })
    const message = {
      role: 'assistant',
      responseId: 'response',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Complete answer' }],
    }
    h.entries.push({ id: 'u', parentId: null, type: 'message', message: { role: 'user', content: 'hello' } })
    h.entries.push({ id: 'a', parentId: 'u', type: 'message', message })
    h.frame({ type: 'message_end', message: h.entries[0].message })
    h.frame({ type: 'message_start', message: { ...message, content: [{ type: 'text', text: '' }] } })
    h.frame({ type: 'message_update', message: { ...message, content: [{ type: 'text', text: 'Complete' }] } })
    await h.bridge.events
    const textEvents = h.events.filter((e) => e.type === 'delta' || (e.type === 'item' && e.item.role === 'assistant'))
    expect(textEvents.length).toBe(1)
    expect(textEvents[0].item.text).toBe('Complete answer')
    expect(textEvents[0].item.status).toBe('completed')
  } finally {
    await h.close()
  }
})
