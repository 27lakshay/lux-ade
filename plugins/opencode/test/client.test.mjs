// One authoring path, three interfaces: the Effect service, its Promise methods and its
// AsyncIterable events run the same session effects against a real OpenCode server
// process (the deterministic fixture). Typed errors, cancellation and disposal must match.
// Run after `pnpm --filter @ade/opencode-provider build`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Effect, Exit, Fiber, Layer } from 'effect'
import { OpenCodeClient, OpenCodeFailure } from '../dist/client.js'
import { OpenCodeSession } from '../dist/session.js'
import { describe as describeProvider } from '../dist/provider.js'

const mock = fileURLToPath(new URL('./fixtures/mock-opencode.mjs', import.meta.url))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ade-opencode-client-'))
  const env = { ...process.env, ADE_MOCK_OPENCODE_DIR: join(root, 'opencode') }
  return {
    root,
    options: { command: mock, cwd: root, env },
    calls: async () =>
      (await readFile(join(root, 'opencode/calls.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const send = {
  session: 'ses_none',
  source_attempt_id: 'a',
  submission: 's',
  message_id: 'm',
  text: 'hello',
  attachments: [],
}

test('the Promise interface rejects with exactly the typed failure the Effect interface fails with', async () => {
  const { options, cleanup } = await fixture()
  const missing = {
    command: null,
    unavailable: 'OpenCode is not installed at ADE_OPENCODE_BIN (/nowhere)',
    cwd: '/',
    env: {},
  }
  const client = OpenCodeClient.make(options)
  const absent = OpenCodeClient.make(missing)
  try {
    for (const [layer, promised] of [
      [OpenCodeSession.layer(options), () => client.send(send)],
      [OpenCodeSession.layer(missing), () => absent.send(send)],
    ]) {
      const effectFailure = await Effect.runPromise(
        Effect.flip(OpenCodeSession.use((session) => session.send(send))).pipe(Effect.provide(layer)),
      )
      const rejection = await promised().then(
        () => assert.fail('expected a rejection'),
        (error) => error,
      )
      assert.ok(rejection instanceof OpenCodeFailure)
      assert.deepEqual(rejection.failure, effectFailure)
    }
    const effectFailure = await Effect.runPromise(
      Effect.flip(OpenCodeSession.use((session) => session.send(send))).pipe(
        Effect.provide(OpenCodeSession.layer(missing)),
      ),
    )
    assert.deepEqual(effectFailure, { code: 'provider_failure', message: missing.unavailable })
  } finally {
    await Promise.all([client.dispose(), absent.dispose()])
    await cleanup()
  }
})

test('an abort interrupts the same effect and abandons the native read in both interfaces', async () => {
  const { root, options, calls, cleanup } = await fixture()
  const client = OpenCodeClient.make(options)
  try {
    const { session } = await client.open({ resume: null, config: { permission_mode: 'default' } })
    await writeFile(join(root, 'opencode/slow-history'), '')
    const request = {
      session,
      context: {
        provider: 'plugin:ade.opencode',
        execution_id: 'run',
        account_id: null,
        lineage: null,
        invalidation_epoch: 0,
      },
      snapshot: null,
      cursor: null,
      max_items: 8,
      max_bytes: 65536,
    }
    const controller = new AbortController()
    const started = Date.now()
    const pending = client.history(request, { signal: controller.signal })
    await delay(100)
    controller.abort()
    const rejection = await pending.then(
      () => assert.fail('expected cancellation'),
      (error) => error,
    )
    assert.ok(Date.now() - started < 900, 'cancellation does not wait for the held read')
    assert.deepEqual(rejection.failure.code, 'cancelled')

    // The Effect interface: interrupting the fiber is the same cancellation.
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(OpenCodeSession.use((service) => service.history(request)))
        yield* Effect.sleep('100 millis')
        return yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(OpenCodeSession.layer(options))),
    )
    assert.ok(Exit.isSuccess(exit))
    await delay(1_200)
    assert.ok(
      (await calls()).some((call) => call.method === 'slow-history-abandoned'),
      'the held native read was abandoned, not left to complete',
    )
  } finally {
    await client.dispose()
    await cleanup()
  }
})

test('events arrive through the AsyncIterable and disposal stops the owned OpenCode server', async () => {
  const { options, calls, cleanup } = await fixture()
  const client = OpenCodeClient.make(options)
  let server
  try {
    const { session } = await client.open({ resume: null, config: { permission_mode: 'default' } })
    server = (await calls())[0].pid
    assert.ok(alive(server))
    const received = []
    const reading = (async () => {
      for await (const event of client.events()) {
        received.push(event)
        if (event.type === 'finished') break
      }
    })()
    const result = await client.send({ ...send, session, message_id: 'fixture-one', text: 'tool' })
    assert.equal(result.turn, 'msg_fixture-one')
    await reading
    assert.deepEqual(
      [...new Set(received.map((event) => event.type))].filter((type) =>
        ['started', 'submitted', 'finished'].includes(type),
      ),
      ['started', 'submitted', 'finished'],
    )
    assert.ok(received.some((event) => event.type === 'item' && event.item.content?.type === 'tool'))
    assert.equal(received.find((event) => event.type === 'finished').status, 'completed')
  } finally {
    await client.dispose()
    await cleanup()
  }
  assert.equal(alive(server), false, 'dispose confirmed the server exit')

  // The Effect interface releases the same way when its scope closes.
  const second = await fixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(OpenCodeSession.layer(second.options))
          const service = Context.get(context, OpenCodeSession)
          yield* service.open({ resume: null, config: { permission_mode: 'default' } })
          server = (yield* Effect.promise(second.calls))[0].pid
        }),
      ),
    )
    assert.equal(alive(server), false)
  } finally {
    await second.cleanup()
  }
})

test('a missing installation makes native operations unavailable with its reason', () => {
  const descriptor = describeProvider({ available: false, reason: 'OpenCode is not installed: nowhere' })
  const byMethod = Object.fromEntries(descriptor.operations.map((operation) => [operation.method, operation]))
  for (const method of ['open', 'send', 'cancel', 'answer', 'history', 'child_transcript'])
    assert.deepEqual(byMethod[method], {
      method,
      tier: byMethod[method].tier,
      availability: 'unavailable',
      reason: 'OpenCode is not installed: nowhere',
    })
  for (const method of ['steer', 'compact', 'rewind', 'configure_mcp'])
    assert.equal(byMethod[method].availability, 'unsupported')
  assert.equal(byMethod.initialize.availability, 'available')
})
