// Opt-in installed-binary test. Never executes a model or uses the user's data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeTransport } from './transport.mjs'
import { SessionApi } from './session-api.mjs'
import { randomUUID } from 'node:crypto'
import { Bridge } from './bridge.mjs'

test(
  'installed OpenCode v2 retains session and immutable queued admission across restarts',
  {
    skip: !process.env.ADE_OPENCODE_LIVE_BIN,
    timeout: 60_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ade-opencode-live-'))
    const project = join(root, 'project')
    await mkdir(project)
    const env = {
      ...process.env,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'),
      OPENCODE_CONFIG_DIR: join(root, 'config/opencode'),
      OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_FFF: '1',
      OPENCODE_DISABLE_FILEWATCHER: '1',
    }
    // Drop explicit config/auth inherited from a developer's terminal as well.
    for (const key of Object.keys(env)) {
      if (
        /API_KEY|AUTH_TOKEN|ACCESS_TOKEN/.test(key) ||
        ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DB'].includes(key)
      )
        delete env[key]
    }
    let server
    try {
      const options = { command: process.env.ADE_OPENCODE_LIVE_BIN, cwd: project, env }
      server = await OpenCodeTransport.start(options)
      assert.equal(server.info.pid, server.pid)
      let api = await SessionApi.connect(server)
      const session = await api.open({ cwd: project })
      assert.ok(session.id)
      const sessionPath = `/api/session/${encodeURIComponent(session.id)}`
      assert.equal((await server.request('GET', `${sessionPath}/message?limit=20`)).data.length, 0)
      assert.deepEqual((await server.request('GET', '/api/session/active')).data, {})
      const events = server.events({ signal: AbortSignal.timeout(5_000) })
      assert.equal((await events.next()).value.type, 'server.connected')
      await events.return()
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=='
      const input = {
        id: `msg_${randomUUID()}`,
        submission: randomUUID(),
        text: 'Do not run this parked test input.',
        resume: false,
        attachments: [
          { attachment: { name: 'pixel.png', media_type: 'image/png' }, data: png },
          {
            attachment: { name: 'notes.txt', media_type: 'text/plain' },
            data: Buffer.from('immutable notes').toString('base64'),
          },
        ],
      }
      assert.equal((await api.submit(session.id, input)).id, input.id)
      assert.equal((await api.submit(session.id, { ...input, retry: true })).id, input.id)
      await assert.rejects(
        api.submit(session.id, { ...input, text: 'Changed content must conflict.' }),
        /different payload/,
      )
      const parked = await api.pending(session.id)
      assert.equal(parked.inbox.length, 1)
      assert.equal(parked.inbox[0].payload.metadata.ade_submission, input.submission)
      assert.equal(parked.inbox[0].payload.files[0].data, png)
      assert.equal(parked.inbox[0].payload.files[0].mime, 'image/png')
      assert.match(parked.inbox[0].payload.text, /Attached file notes.txt:\nimmutable notes/)
      await assert.rejects(api.submit(session.id, { ...input, attachments: [], retry: true }), /different payload/)
      assert.equal(parked.active, false)
      await server.stop()
      server = await OpenCodeTransport.start(options)
      api = await SessionApi.connect(server)
      assert.equal((await api.open({ resume: session.id, cwd: project })).id, session.id)
      await assert.rejects(api.open({ resume: session.id, cwd: root }), /different directory/)
      const recovered = await api.pending(session.id)
      assert.equal(recovered.inbox[0].id, input.id)
      assert.equal(recovered.inbox[0].payload.files[0].data, png)
      assert.equal(recovered.active, false)
      assert.deepEqual(await Array.fromAsync(api.messages(session.id)), [])
      assert.equal((await api.interrupt(session.id)).interrupted, false)
      assert.equal((await api.pending(session.id)).inbox.length, 1)
      await api.cancelQueued(session.id, input.id)
      assert.equal((await api.pending(session.id)).inbox.length, 0)
      await assert.rejects(api.submit(session.id, { ...input, retry: true }), /refusing to replay/)
      await server.stop()
      server = await OpenCodeTransport.start(options)
      api = await SessionApi.connect(server)
      await assert.rejects(api.submit(session.id, { ...input, retry: true }), /refusing to replay/)
      assert.deepEqual((await server.request('GET', '/api/session/active')).data, {})
      const parkedInput = { ...input, id: `msg_${randomUUID()}`, submission: randomUUID() }
      await api.submit(session.id, parkedInput)
      const output = []
      const bridge = new Bridge((frame) => output.push(frame.params), {
        cwd: project,
        connect: async () => ({ transport: server, api }),
      })
      try {
        assert.equal((await bridge.open({ resume: session.id, config: {} })).session, session.id)
        const recovery = output.find((event) => event.type === 'request')
        assert.equal(recovery.method, 'opencode/recover')
        assert.equal((await api.pending(session.id)).active, false)
        await bridge.answer({ id: recovery.id, decision: 'decline' })
        assert.equal((await api.pending(session.id)).inbox.length, 0)
        assert.equal(output.find((event) => event.type === 'finished').status, 'interrupted')
      } finally {
        await bridge.close()
      }
    } finally {
      await server?.stop()
      await rm(root, { recursive: true, force: true })
    }
  },
)
