import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { OpenCodeTransport } from '../src/native/transport.mjs'

const fixture = fileURLToPath(new URL('./fixtures/fixture.mjs', import.meta.url))
const start = (mode, options = {}) =>
  OpenCodeTransport.start({
    command: process.execPath,
    prefixArgs: [fixture],
    env: { ...process.env, ADE_TEST_MODE: mode },
    ...options,
  })

test('authenticated owned server supports JSON, no-content and stdin lease shutdown', async () => {
  const server = await start('normal')
  try {
    assert.deepEqual(await server.request('POST', '/api/test', { text: 'hello' }), {
      method: 'POST',
      body: { text: 'hello' },
    })
    assert.equal(await server.request('POST', '/api/empty', {}), null)
    await assert.rejects(
      server.request('GET', '/api/fail'),
      (error) => /HTTP 403/.test(error.message) && !error.message.includes('SECRET'),
    )
    await assert.rejects(server.request('GET', '/api/redirect'))
    await assert.rejects(server.request('GET', '//example.com/api'), /Invalid/)
  } finally {
    await server.stop()
  }
  assert.throws(() => process.kill(server.pid, 0), { code: 'ESRCH' })
  await server.stop()
})

for (const mode of ['old', 'foreign', 'external', 'garbage', 'timeout', 'unauthorized']) {
  test(`rejects ${mode} server without retaining a process`, async () => {
    await assert.rejects(start(mode, { startupTimeout: 250 }))
  })
}

test('recognizes installed v2 health route and waits for owned server readiness', async () => {
  for (const mode of ['installed', 'warming']) {
    const server = await start(mode)
    try {
      assert.equal(server.info.healthPath, mode === 'installed' ? '/api/health' : '/api/info')
      assert.equal(server.info.pid, server.pid)
    } finally {
      await server.stop()
    }
  }
})

test('missing executable fails promptly', async () => {
  await assert.rejects(OpenCodeTransport.start({ command: '/nonexistent/ade-opencode' }), /Could not launch/)
})

test('request deadlines and response size are bounded', async () => {
  const server = await start('normal', { requestTimeout: 250 })
  try {
    await assert.rejects(server.request('GET', '/api/slow'), /timeout/i)
    await assert.rejects(server.request('GET', '/api/large'), /size limit/)
  } finally {
    await server.stop()
  }
})

test('SSE supports split Unicode, CRLF and multiline data, and exposes disconnect', async () => {
  const server = await start('normal')
  try {
    const events = server.events()
    assert.deepEqual((await events.next()).value, { type: 'test', text: '🙂' })
    await assert.rejects(events.next(), /reload session state/)
  } finally {
    await server.stop()
  }
})

test('SSE enforces event size limit', async () => {
  const server = await start('large-event')
  try {
    await assert.rejects(server.events().next(), /size limit/)
  } finally {
    await server.stop()
  }
})

test('shutdown aborts outstanding HTTP requests', async () => {
  const server = await start('normal')
  const pending = assert.rejects(server.request('GET', '/api/slow'), /stopped/)
  await server.stop()
  await pending
})
