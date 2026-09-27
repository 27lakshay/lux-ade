// Pure-core tests for the plugin host's message handling (AGENTS.md test policy).
// Run: node --test packages/plugin-host/src/protocol.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTIVATION_FAILED,
  COMMAND_FAILED,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  NOT_ACTIVE,
  PARSE_ERROR,
  STALE_GENERATION,
  UNKNOWN_COMMAND,
  createHost,
  entryPath,
} from './protocol.mjs'

const ARTIFACT = '/profile/plugins/artifacts/acme.notes/1.0.0'
const activateParams = (extra = {}) => ({
  plugin_id: 'acme.notes',
  generation: 3,
  artifact_path: ARTIFACT,
  entry: 'dist/backend.mjs',
  commands: ['acme.notes.count', 'acme.notes.fail'],
  settings: { wrap: true },
  ...extra,
})

/** A fake backend that records what the host did to it. */
function fixture(overrides = {}) {
  const calls = []
  const backend = {
    activate(context) {
      calls.push(['activate', context.pluginId, context.generation, context.settings.wrap])
      context.commands.register('acme.notes.count', (args, meta) => ({
        count: args.n + 1,
        generation: meta.generation,
      }))
      context.commands.register('acme.notes.fail', () => {
        throw new Error('disk full')
      })
      backend.context = context
    },
    deactivate() {
      calls.push(['deactivate'])
    },
    ...overrides,
  }
  const loaded = []
  const host = createHost({
    load: async (url) => {
      loaded.push(url)
      return backend
    },
    now: () => 1000,
    log: (line) => calls.push(['log', line]),
  })
  let id = 0
  const request = (method, params) => host.handle({ jsonrpc: '2.0', id: ++id, method, params })
  return { host, backend, calls, loaded, request }
}

test('activates once, loads the entry inside the artifact and reports registered commands', async () => {
  const { calls, loaded, request } = fixture()
  const reply = await request('activate', activateParams())
  assert.deepEqual(reply.result, { generation: 3, registered: ['acme.notes.count', 'acme.notes.fail'] })
  assert.deepEqual(loaded, [`file://${ARTIFACT}/dist/backend.mjs`])
  assert.deepEqual(calls[0], ['activate', 'acme.notes', 3, true])
  const again = await request('activate', activateParams({ generation: 4 }))
  assert.equal(again.error.code, NOT_ACTIVE)
})

test('invokes a registered command with its generation and returns JSON', async () => {
  const { request } = fixture()
  await request('activate', activateParams())
  const reply = await request('invoke', {
    generation: 3,
    command_id: 'acme.notes.count',
    args: { n: 1 },
    invocation_id: 'op-1',
  })
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 2, result: { value: { count: 2, generation: 3 } } })
})

test('separates refusals before plugin code from failures inside it', async () => {
  const { request } = fixture()
  const early = await request('invoke', { generation: 3, command_id: 'acme.notes.count' })
  assert.equal(early.error.code, NOT_ACTIVE)
  await request('activate', activateParams())
  assert.equal(
    (await request('invoke', { generation: 2, command_id: 'acme.notes.count' })).error.code,
    STALE_GENERATION,
  )
  assert.equal((await request('invoke', { generation: 3, command_id: 'acme.notes.other' })).error.code, UNKNOWN_COMMAND)
  assert.equal((await request('invoke', { generation: 0, command_id: 'acme.notes.count' })).error.code, INVALID_PARAMS)
  const failed = await request('invoke', { generation: 3, command_id: 'acme.notes.fail' })
  assert.deepEqual(failed.error, { code: COMMAND_FAILED, message: 'disk full' })
  for (const code of [NOT_ACTIVE, STALE_GENERATION, UNKNOWN_COMMAND, INVALID_PARAMS])
    assert.ok(code > COMMAND_FAILED || code < -32100)
})

test('refuses undeclared, duplicate and late registrations; a handle disposes only its own handler', async () => {
  const { backend, request } = fixture()
  await request('activate', activateParams())
  const { commands } = backend.context
  assert.throws(() => commands.register('acme.notes.secret', () => 1), /not declared/)
  assert.throws(() => commands.register('acme.notes.count', () => 1), /already registered/)
  await request('deactivate', { generation: 3 })
  assert.throws(() => commands.register('acme.notes.count', () => 1), /deactivated/)
})

test('a stale disposable does not remove a newer handler', async () => {
  const { backend, request } = fixture({
    activate(context) {
      const first = context.commands.register('acme.notes.count', () => 'first')
      first.dispose()
      context.commands.register('acme.notes.count', () => 'second')
      first.dispose()
      backend.context = context
    },
  })
  await request('activate', activateParams())
  const reply = await request('invoke', { generation: 3, command_id: 'acme.notes.count' })
  assert.equal(reply.result.value, 'second')
})

test('deactivate disposes handlers, runs the plugin hook once and is idempotent', async () => {
  const { calls, request, host } = fixture()
  await request('activate', activateParams())
  assert.equal((await request('deactivate', { generation: 2 })).error.code, STALE_GENERATION)
  assert.deepEqual((await request('deactivate', { generation: 3 })).result, { deactivated: true })
  assert.deepEqual((await request('deactivate', { generation: 3 })).result, { deactivated: false })
  assert.equal(calls.filter(([name]) => name === 'deactivate').length, 1)
  assert.equal((await request('invoke', { generation: 3, command_id: 'acme.notes.count' })).error.code, NOT_ACTIVE)
  assert.deepEqual(host.health(), { state: 'deactivated', generation: 3, registered: [], pending: 0, uptime_ms: 0 })
})

test('a failing activation leaves the host deactivated with an explicit error', async () => {
  const { request } = fixture({
    activate() {
      throw new Error('missing token')
    },
  })
  const reply = await request('activate', activateParams())
  assert.equal(reply.error.code, ACTIVATION_FAILED)
  assert.match(reply.error.message, /missing token/)
  assert.equal((await request('health', {})).result.state, 'deactivated')
})

test('a deactivate that arrives during activation wins', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { request, calls } = fixture({
    async activate() {
      await gate
    },
  })
  const activation = request('activate', activateParams())
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual((await request('deactivate', { generation: 3 })).result, { deactivated: true })
  release()
  assert.equal((await activation).error.code, NOT_ACTIVE)
  assert.equal((await request('health', {})).result.state, 'deactivated')
  assert.equal(calls.filter(([name]) => name === 'deactivate').length, 1)
})

test('rejects entries that leave the artifact', () => {
  assert.equal(entryPath('/a/b', 'dist/x.mjs'), '/a/b/dist/x.mjs')
  for (const entry of ['../x.mjs', '/etc/passwd', '.', 'dist/../../x.mjs']) {
    assert.throws(() => entryPath('/a/b', entry), /artifact/, entry)
  }
  assert.throws(() => entryPath('relative', 'x.mjs'), /absolute/)
})

test('answers malformed input with JSON-RPC errors and ignores notifications', async () => {
  const { host } = fixture()
  assert.equal((await host.handleLine('{nope')).error.code, PARSE_ERROR)
  assert.equal((await host.handleLine('[1]')).error.code, INVALID_REQUEST)
  assert.equal(
    (await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'toString' }))).error.code,
    METHOD_NOT_FOUND,
  )
  assert.equal(
    (await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'health', params: [1] }))).error.code,
    INVALID_PARAMS,
  )
  assert.equal(await host.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'health' })), null)
  assert.equal((await host.handleLine('x'.repeat(1024 * 1024 + 1))).error.code, INVALID_REQUEST)
})

test('health reports state, generation, registrations and pending invocations', async () => {
  let finish
  const { request, host } = fixture({
    activate(context) {
      context.commands.register(
        'acme.notes.count',
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
    },
  })
  assert.equal(host.health().state, 'idle')
  await request('activate', activateParams())
  const running = request('invoke', { generation: 3, command_id: 'acme.notes.count' })
  await Promise.resolve()
  assert.deepEqual(host.health(), {
    state: 'active',
    generation: 3,
    registered: ['acme.notes.count'],
    pending: 1,
    uptime_ms: 0,
  })
  finish(undefined)
  assert.deepEqual((await running).result, { value: null })
  assert.equal(host.health().pending, 0)
})
