// Ticket 02: install the separately packaged Effect diagnostic worker through the real plugin path.
import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, test } from '../fixtures'
import { providerSdkDiagnosticArtifact } from '../fixtures/plugins'

test('an installed Effect SDK diagnostic provider reports compatibility without native work', async ({
  ade,
  profile,
}) => {
  const nativeLedgerBefore = await Promise.all([profile.mockCalls('claude'), profile.mockCalls('codex')])
  const artifact = await providerSdkDiagnosticArtifact(ade.root)
  const installed = await profile.call('plugin.install', {
    operation_id: 'install-sdk-diagnostic',
    source: { kind: 'local', path: artifact },
  })
  const pluginId = installed.plugin.id
  await profile.call('plugin.enable', { plugin_id: pluginId })
  const provider = 'plugin:' + pluginId

  const inspected = await profile.call('provider.inspect', { provider })
  expect(inspected).toMatchObject({
    type: 'provider_inspect',
    provider,
    state: 'installed_unchecked',
    descriptor: {
      requirements: { sdk_api_version: 2, sdk_version: '0.2.0' },
      operations: expect.arrayContaining([
        expect.objectContaining({ method: 'initialize', tier: 'query', availability: 'available' }),
        expect.objectContaining({ method: 'open', tier: 'effect_command', availability: 'unsupported' }),
        expect.objectContaining({ method: 'send', tier: 'effect_command', availability: 'unsupported' }),
      ]),
    },
  })

  const readiness = await profile.call('provider.readiness', { provider })
  expect(readiness).toMatchObject({
    state: 'installed_unchecked',
    checks: [
      expect.objectContaining({ check: 'worker.initialize', state: 'passed' }),
      expect.objectContaining({ check: 'provider.native_work', state: 'skipped' }),
    ],
  })

  const cli = await profile.cli('provider', 'inspect', provider)
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'provider_inspect', provider, state: 'installed_unchecked' })
  expect((await profile.call('runtime.status', {})).agents).toEqual([])
  expect(await Promise.all([profile.mockCalls('claude'), profile.mockCalls('codex')])).toEqual(nativeLedgerBefore)
})

test('the Node SDK drains admitted replies at EOF under backpressure, bounds output, and releases once', async ({
  ade,
}) => {
  const artifact = await providerSdkDiagnosticArtifact(ade.root)
  const script = join(artifact, '.sdk-transport-worker.mjs')
  await writeFile(
    script,
    [
      'import { Effect, Layer } from "effect"',
      'import { DEFAULT_LIMITS, SDK_REQUIREMENTS } from "@ade/provider-sdk"',
      'import { runProviderWorker } from "@ade/provider-sdk/node"',
      'const reason = "r".repeat(Math.floor(DEFAULT_LIMITS.max_output_frame_bytes / 8))',
      'const descriptor = {',
      '  compatible_protocol_versions: [2],',
      '  name: "Transport regression worker",',
      '  capabilities: [],',
      '  permission_modes: ["default"],',
      '  operations: [',
      '    { method: "initialize", tier: "query", availability: "available", reason: "" },',
      '    { method: "open", tier: "effect_command", availability: "unsupported", reason },',
      '    { method: "send", tier: "effect_command", availability: "available", reason: "" },',
      '    { method: "steer", tier: "effect_command", availability: "unsupported", reason },',
      '    { method: "cancel", tier: "idempotent_command", availability: "unsupported", reason },',
      '    { method: "answer", tier: "effect_command", availability: "unsupported", reason },',
      '    { method: "history", tier: "query", availability: "unsupported", reason },',
      '  ],',
      '  limits: DEFAULT_LIMITS,',
      '  requirements: SDK_REQUIREMENTS,',
      '}',
      'runProviderWorker({',
      '  descriptor,',
      '  dependencies: Layer.empty,',
      '  acquire: Effect.succeed({',
      '    send: (params) => Effect.succeed({ turn: params.text === "over-limit" ? "x".repeat(DEFAULT_LIMITS.max_output_frame_bytes) : params.text === "backpressure" ? "x".repeat(512000) : "normal", admitted: true, dispatch: "dispatched", native_outcome: "accepted" }),',
      '    close: Effect.sync(() => process.stderr.write("SDK_FACTORY_RELEASE")),',
      '  }),',
      '})',
    ].join('\n'),
  )

  const startWorker = () => {
    const child = spawn(process.execPath, [script], { cwd: artifact, stdio: 'pipe' })
    const lines = createInterface({ input: child.stdout })
    const iterator = lines[Symbol.asyncIterator]()
    let stderr = ''
    let spawnError: Error | undefined
    child.stdout.pause()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('error', (error) => {
        spawnError = error
        resolve({ code: null, signal: null })
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const send = (frame: Record<string, unknown>) => child.stdin.write(JSON.stringify(frame) + '\n')
    const sendBatchAndEnd = (frames: Record<string, unknown>[]) => {
      child.stdin.end(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n')
    }
    const read = async () => {
      child.stdout.resume()
      const next = await iterator.next()
      child.stdout.pause()
      if (next.done) throw new Error('Provider SDK worker ended before a response: ' + String(spawnError) + stderr)
      return JSON.parse(next.value)
    }
    return {
      send,
      sendBatchAndEnd,
      read,
      async exchange(frame: Record<string, unknown>) {
        send(frame)
        return read()
      },
      async finish() {
        if (!child.stdin.writableEnded) child.stdin.end()
        child.stdout.resume()
        const exit = await closed
        lines.close()
        return { ...exit, stderr }
      },
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await closed
        lines.close()
      },
    }
  }

  const worker = startWorker()
  try {
    expect(
      await worker.exchange({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { versions: [1] } }),
    ).toMatchObject({ id: 1, error: { data: { code: 'protocol_mismatch' } } })
    expect(
      await worker.exchange({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { versions: [2] } }),
    ).toMatchObject({ id: 9, result: { protocol_version: 2 } })
    expect(
      await worker.exchange({
        jsonrpc: '2.0',
        id: 2,
        method: 'send',
        params: {
          session: 'fixture',
          source_attempt_id: 'attempt',
          submission: 'over-limit',
          message_id: null,
          attachments: [],
          text: 'over-limit',
        },
      }),
    ).toMatchObject({ id: 2, error: { data: { code: 'resource_limit' } } })
    expect(
      await worker.exchange({
        jsonrpc: '2.0',
        id: 3,
        method: 'send',
        params: {
          session: 'fixture',
          source_attempt_id: 'attempt',
          submission: 'normal',
          message_id: null,
          attachments: [],
          text: 'normal',
        },
      }),
    ).toMatchObject({ id: 3, result: { turn: 'normal' } })

    worker.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'send',
      params: {
        session: 'fixture',
        source_attempt_id: 'attempt',
        submission: 'pressure',
        message_id: null,
        attachments: [],
        text: 'backpressure',
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    worker.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'send',
      params: {
        session: 'fixture',
        source_attempt_id: 'attempt',
        submission: 'normal-2',
        message_id: null,
        attachments: [],
        text: 'normal',
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await worker.read()).toMatchObject({ id: 4, result: { turn: 'x'.repeat(512_000) } })
    expect(await worker.read()).toMatchObject({ id: 5, result: { turn: 'normal' } })

    const eofFrames: Record<string, unknown>[] = [6, 7, 8].map((id) => ({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: { versions: [2] },
    }))
    worker.sendBatchAndEnd(eofFrames)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const eofReplies = [await worker.read(), await worker.read(), await worker.read()]
    expect(eofReplies.map((reply) => reply.id)).toEqual([6, 7, 8])
    expect(eofReplies.map((reply) => reply.result?.protocol_version)).toEqual([2, 2, 2])

    const exit = await worker.finish()
    expect(exit.code).toBe(0)
    expect(exit.stderr).not.toContain('EPIPE')
    expect(exit.stderr.split('SDK_FACTORY_RELEASE').length - 1).toBe(1)
  } finally {
    await worker.stop()
    await rm(script, { force: true })
  }
})

test('the Node SDK answers a cancellation while a steer holds the shared control lane', async ({ ade }) => {
  const artifact = await providerSdkDiagnosticArtifact(ade.root)
  const script = join(artifact, '.sdk-cancel-lane-worker.mjs')
  await writeFile(
    script,
    [
      'import { Effect, Layer } from "effect"',
      'import { DEFAULT_LIMITS, SDK_REQUIREMENTS } from "@ade/provider-sdk"',
      'import { runProviderWorker } from "@ade/provider-sdk/node"',
      'const available = (method, tier) => ({ method, tier, availability: "available", reason: "" })',
      'runProviderWorker({',
      '  descriptor: {',
      '    compatible_protocol_versions: [2],',
      '    name: "Cancel lane regression worker",',
      '    capabilities: [],',
      '    permission_modes: ["default"],',
      '    operations: [available("initialize", "query"), available("steer", "effect_command"), available("cancel", "idempotent_command")],',
      '    limits: DEFAULT_LIMITS,',
      '    requirements: SDK_REQUIREMENTS,',
      '  },',
      '  dependencies: Layer.empty,',
      '  acquire: Effect.succeed({',
      '    steer: () => Effect.never,',
      '    cancel: () => Effect.succeed({ type: "cancel_result", evidence: { scope: "turn", interruption_requested: true, termination: "requested", active_work_remaining: null, queued_work_count: null, background_work_remaining: null, observed_at_ms: null } }),',
      '  }),',
      '})',
    ].join('\n'),
  )
  const child = spawn(process.execPath, [script], { cwd: artifact, stdio: 'pipe' })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const send = (frame: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
  const read = async () => {
    const next = await lines.next()
    if (next.done) throw new Error('Provider SDK worker ended before a response: ' + stderr)
    return JSON.parse(next.value)
  }
  try {
    send({ id: 1, method: 'initialize', params: { versions: [2] } })
    expect(await read()).toMatchObject({ id: 1, result: { protocol_version: 2 } })
    // The steer never settles, so it holds the steer/answer lane.
    send({
      id: 2,
      method: 'steer',
      params: { session: 's', turn: 't', message_id: 'm', text: 'never settles', attachments: [] },
    })
    send({ id: 3, method: 'cancel', params: { session: 's', source_attempt_id: 'a', submission_id: 'b', turn: 't' } })
    expect(await read()).toMatchObject({ id: 3, result: { type: 'cancel_result', evidence: { scope: 'turn' } } })
  } finally {
    child.kill()
    await rm(script, { force: true })
  }
})

test('the Node SDK keeps an expected failure, a defect, an interruption and a shutdown apart', async ({ ade }) => {
  const artifact = await providerSdkDiagnosticArtifact(ade.root)
  const script = join(artifact, '.sdk-causes-worker.mjs')
  await writeFile(
    script,
    [
      'import { Effect, Layer } from "effect"',
      'import { DEFAULT_LIMITS, SDK_REQUIREMENTS } from "@ade/provider-sdk"',
      'import { runProviderWorker } from "@ade/provider-sdk/node"',
      'const available = (method, tier) => ({ method, tier, availability: "available", reason: "" })',
      'runProviderWorker({',
      '  descriptor: {',
      '    compatible_protocol_versions: [2],',
      '    name: "Failure cause worker",',
      '    capabilities: [],',
      '    permission_modes: ["default"],',
      '    operations: [available("initialize", "query"), available("steer", "effect_command")],',
      '    limits: DEFAULT_LIMITS,',
      '    requirements: SDK_REQUIREMENTS,',
      '  },',
      '  dependencies: Layer.empty,',
      '  acquire: Effect.succeed({',
      '    steer: (p) =>',
      '      p.text === "expected" ? Effect.fail({ code: "rate_limited", message: "Native rate limit" })',
      '      : p.text === "defect" ? Effect.die(new Error("bug"))',
      '      : p.text === "interrupt" ? Effect.interrupt',
      '      : Effect.never,',
      '  }),',
      '})',
    ].join('\n'),
  )
  const child = spawn(process.execPath, [script], { cwd: artifact, stdio: 'pipe' })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const send = (frame: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
  const read = async () => {
    const next = await lines.next()
    return next.done ? null : JSON.parse(next.value)
  }
  const steer = (id: number, text: string) =>
    send({ id, method: 'steer', params: { session: 's', turn: 't', message_id: 'm', text, attachments: [] } })
  try {
    send({ id: 1, method: 'initialize', params: { versions: [2] } })
    expect(await read()).toMatchObject({ id: 1 })
    const codes: Record<string, string> = {}
    for (const [id, text] of [
      [2, 'expected'],
      [3, 'defect'],
      [4, 'interrupt'],
    ] as const) {
      steer(id, text)
      codes[text] = (await read())?.error?.data?.code
    }
    expect(codes).toEqual({ expected: 'rate_limited', defect: 'integration_bug', interrupt: 'cancelled' })
    // At shutdown a pending request gets no reply at all: the host reads a closed transport as an
    // unknown outcome, never as a cancellation or a success.
    steer(5, 'pending')
    child.stdin.end()
    expect(await read()).toBeNull()
  } finally {
    child.kill()
    await rm(script, { force: true })
  }
})
