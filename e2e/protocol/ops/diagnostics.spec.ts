// F136 resource visibility and F137 diagnostics (architecture section 10:
// queue and spool sizes, dropped and coalesced counts, retention status,
// resource claims and reasons for unknown execution). `diagnostics.status`
// correlates host, profile, daemon boot and runtime incarnation;
// `diagnostics.export` wraps it with allow-listed log records in a bounded,
// redacted bundle. Faults: a runtime crash, a daemon crash during an effect,
// a subscriber that stops reading.
import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  expect,
  isRunning,
  prompts,
  send,
  startConversation,
  test,
  waitForIdle,
  type ScratchProfile,
} from '../fixtures'
import { waitForAttemptRecord } from '../fixtures/recovery'
import { operation, operationId, register, settled } from '../worktrees/lifecycle'
import { age, names, plantDiagnosticLog, serviceLogDirectory, startService } from './steps'

async function status(profile: ScratchProfile) {
  return profile.call('diagnostics.status', {})
}

async function conversationState(profile: ScratchProfile, conversationId: string): Promise<string> {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).conversation.status
}

async function killAndWait(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* Already gone. */
  }
  await expect.poll(() => isRunning(pid)).toBe(false)
}

test('status correlates identity, queues, live runs, terminals, services and claims with their incarnations', async ({
  profile,
  repo,
}) => {
  const web = await startService(profile, repo.path, 'web')
  const owner = web.started.service.terminal_owner!
  const shellPid = (web.started.metrics as { shell_pid: number }).shell_pid

  // A held turn is a live Agent run; a prompt sent behind it waits in the durable queue.
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect.poll(() => conversationState(profile, conversationId)).toBe('running')
  await profile.call('queue.enqueue', {
    conversation_id: conversationId,
    request_id: 'diag-queued',
    text: prompts.turn,
  })

  let report = await status(profile)
  await expect
    .poll(async () => {
      report = await status(profile)
      return report.live.runs.some((run) => run.conversation_id === conversationId)
    })
    .toBe(true)

  expect(report.identity).toMatchObject({
    boot_id: profile.hello.boot_id,
    daemon_pid: profile.hello.pid,
    runtime_instance: profile.hello.runtime_instance,
    runtime_pid: profile.hello.runtime_pid,
    host_key: expect.stringMatching(/^([0-9a-f]{16}|unknown)$/),
    profile_id: expect.any(String),
  })
  expect(report.degraded).toEqual([])
  expect(report.unknown).toEqual([])
  expect(report.live.observed).toBe(true)
  expect(report.live.runtime_instance).toBe(profile.hello.runtime_instance)

  // The Agent run with its execution attempt and process.
  const run = report.live.runs.find((entry) => entry.conversation_id === conversationId)!
  expect(run).toMatchObject({ provider: 'codex', run_id: expect.any(String), account_pinned: false })
  expect(await isRunning(run.pid!)).toBe(true)
  const queues = Object.fromEntries(report.queues.map((queue) => [queue.name, queue]))
  expect(queues['runtime.agent_runs']).toMatchObject({ unit: 'items', capacity: 16, provenance: 'exact' })
  expect(queues['runtime.agent_runs'].depth).toBeGreaterThanOrEqual(1)
  expect(queues['conversation.queued_prompts']).toMatchObject({ depth: 1, provenance: 'exact' })
  expect(queues['terminal.scrollback']).toMatchObject({ unit: 'bytes', provenance: 'exact' })
  expect(queues['feed.subscribers'].provenance).toBe('exact')

  // The service, its terminal and incarnation, and its port claim.
  const service = report.live.services.find((entry) => entry.name === 'web')!
  expect(service).toMatchObject({
    workspace_id: web.workspace.id,
    running: true,
    terminal_id: owner.terminal_id,
    last_run_transfer_id: owner.transfer_id,
  })
  const terminal = report.live.terminals.find((entry) => entry.terminal_id === owner.terminal_id)!
  expect(terminal).toMatchObject({
    workspace_id: web.workspace.id,
    transfer_id: owner.transfer_id,
    shell_running: true,
    shell_pid: shellPid,
    durable_log_failed: false,
  })
  expect(report.claims.unresolved).toEqual([])
  expect(report.claims.session_worktree_leases).toBeGreaterThanOrEqual(1)
  const port = web.service.ports.PORT
  const portClaims = (await profile.call('resources.inspect', { resource: 'port' })).claims
  expect(portClaims.filter((claim) => claim.port === port)).toEqual([
    expect.objectContaining({ state: 'active', mine: true, owner_live: true }),
  ])

  // Receipts are counted per store; every counter says what it counts and how far to trust it.
  expect(report.receipts.map((store) => store.store)).toEqual(expect.arrayContaining(['sessions', 'browser']))
  expect(report.receipts.find((store) => store.store === 'sessions')).toMatchObject({ available: true, unknown: 0 })
  for (const counter of report.counters) {
    if (counter.value === null) expect(counter.provenance).toBe('unavailable')
    else expect(counter.provenance).not.toBe('unavailable')
    expect(counter.note.length).toBeGreaterThan(0)
  }
  expect(report.retention).toMatchObject({ receipts_past_retention: 0, logs: { available: true } })

  // The CLI reports the same identity.
  const cli = await profile.cli('diagnostics', 'status')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'diagnostics_status', identity: { boot_id: profile.hello.boot_id } })

  // A cancelled turn and a stopped service.
  await profile.call('queue.cancel', { conversation_id: conversationId, request_id: 'diag-queued' })
  await profile.call('agent.cancel', { conversation_id: conversationId })
  await expect.poll(() => conversationState(profile, conversationId)).toBe('interrupted')
  // A turn the user cancelled has a known outcome; it is not unknown execution.
  expect((await status(profile)).unknown).toEqual([])
  await profile.call('service.stop', { workspace_id: web.workspace.id, name: 'web' })
  // The provider session stays attached between turns; the stopped service
  // leaves the live terminals and is reported not running.
  await expect
    .poll(async () => {
      const after = await status(profile)
      return [
        after.live.services.find((entry) => entry.name === 'web')?.running,
        after.live.terminals.some((entry) => entry.transfer_id === owner.transfer_id && entry.shell_running),
      ]
    })
    .toEqual([false, false])
})

test('a runtime crash leaves unknown execution with reasons: an unobserved runtime, an interrupted turn and an unresolved service claim', async ({
  profile,
  repo,
}) => {
  test.setTimeout(90_000)
  // The server ignores SIGHUP, so it outlives the runtime that owned its PTY.
  const web = await startService(profile, repo.path, 'web', { E2E_IGNORE_HUP: '1' })
  const owner = web.started.service.terminal_owner!
  const shellPid = (web.started.metrics as { shell_pid: number }).shell_pid
  await waitForAttemptRecord(profile, `terminal:${web.workspace.id}:${owner.terminal_id}`)
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.hold)
  await expect.poll(() => conversationState(profile, conversationId)).toBe('running')
  const crashed = profile.hello

  await profile.killRuntime()
  await expect.poll(() => conversationState(profile, conversationId)).toBe('interrupted')

  // The report still answers without a runtime and never reports the gap as empty.
  const blind = await status(profile)
  expect(blind.live).toMatchObject({ observed: false, runs: [], terminals: [] })
  expect(blind.live.services.find((entry) => entry.name === 'web')?.running).toBeNull()
  expect(blind.degraded.length).toBeGreaterThan(0)
  const blindQueues = Object.fromEntries(blind.queues.map((queue) => [queue.name, queue]))
  expect(blindQueues['runtime.agent_runs']).toMatchObject({ depth: null, provenance: 'unavailable' })
  expect(blind.unknown).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: 'runtime',
        subject: crashed.runtime_instance,
        reason: expect.stringMatching(/not observed/),
      }),
      expect.objectContaining({
        source: 'conversation',
        subject: conversationId,
        scope: expect.any(String),
        reason: expect.stringMatching(/interrupted/),
      }),
    ]),
  )
  const blindExport = await profile.call('diagnostics.export', {})
  expect(blindExport.status.live.observed).toBe(false)

  // A new daemon starts a new runtime. The service run it never saw is an
  // unresolved claim naming the incarnation it expects.
  const replaced = await profile.restartDaemon()
  const after = await status(profile)
  expect(after.identity).toMatchObject({ runtime_instance: replaced.runtime_instance, boot_id: replaced.boot_id })
  expect(after.identity.runtime_instance).not.toBe(crashed.runtime_instance)
  expect(after.live.observed).toBe(true)
  expect(after.claims.unresolved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'service',
        workspace_id: web.workspace.id,
        subject: 'web',
        incarnation: owner.transfer_id,
        reason: expect.any(String),
      }),
    ]),
  )
  const claim = after.unknown.find((entry) => entry.source === 'claim' && entry.subject === 'web')
  expect(claim).toMatchObject({ scope: web.workspace.id })
  expect(claim!.reason).toMatch(/runtime restarted: 1 process\(es\) from it still run/)
  expect(after.unknown.some((entry) => entry.source === 'conversation' && entry.subject === conversationId)).toBe(true)
  expect(after.unknown.some((entry) => entry.source === 'runtime')).toBe(false)
  expect(after.live.services.find((entry) => entry.name === 'web')).toMatchObject({
    running: false,
    last_run_transfer_id: owner.transfer_id,
  })

  // The orphan still runs and still holds its port claim, now quarantined.
  expect(await isRunning(shellPid)).toBe(true)
  const port = web.service.ports.PORT
  const quarantined = (await profile.call('resources.inspect', { resource: 'port' })).claims.filter(
    (entry) => entry.port === port,
  )
  expect(quarantined).toHaveLength(1)

  // Retention never judges the log of an unresolved service unowned, however old.
  for (const file of await names(serviceLogDirectory(profile))) {
    if (web.logKeys.some((key) => file.startsWith(key))) await age(join(serviceLogDirectory(profile), file), 30)
  }
  const retention = await profile.call('retention.preview', {})
  expect(retention.candidates.filter((candidate) => web.logKeys.includes(candidate.id))).toEqual([])

  // Resuming the turn and stopping the gone service clear their unknown entries.
  await profile.call('agent.resume', { conversation_id: conversationId })
  await waitForIdle(profile, conversationId)
  await killAndWait(shellPid)
  await profile.call('service.stop', { workspace_id: web.workspace.id, name: 'web' })
  await expect.poll(async () => (await status(profile)).unknown).toEqual([])
  expect((await status(profile)).claims.unresolved).toEqual([])
})

test('an effect interrupted by a daemon crash is an unknown receipt with its operation and store', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const repositoryId = await register(profile, repo)
  const started = join(ade.root, 'setup-started')
  const release = join(ade.root, 'setup-release')
  await profile.call('worktree.configure', {
    project_id: repositoryId,
    config: {
      setup: [
        {
          name: 'wait',
          command: ['/bin/sh', '-c', `: > '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`],
          timeout_seconds: 60,
        },
      ],
    },
  })
  const id = operationId('diagnostics-interrupted')
  await profile.call('worktree.create', { project_id: repositoryId, operation_id: id, name: 'interrupted' })
  await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true)
  expect((await operation(profile, repositoryId, id)).status).toBe('running')
  try {
    await profile.killDaemon()
  } finally {
    await writeFile(release, '')
  }
  await profile.restartDaemon()
  expect((await settled(profile, repositoryId, id)).status).toBe('interrupted')

  const report = await status(profile)
  const lifecycle = report.receipts.find((store) => store.store === 'lifecycle')!
  expect(lifecycle).toMatchObject({ available: true })
  expect(lifecycle.unknown).toBeGreaterThanOrEqual(1)
  expect(report.unknown).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: 'receipt',
        operation: 'worktree.create',
        scope: 'lifecycle',
        reason: expect.stringMatching(/outcome was lost/),
        since: expect.any(Number),
      }),
    ]),
  )
  // The export carries the same reason.
  const bundle = await profile.call('diagnostics.export', { max_events: 0 })
  expect(
    bundle.status.unknown.some((entry) => entry.source === 'receipt' && entry.operation === 'worktree.create'),
  ).toBe(true)
})

// Credentials and transcript text planted in every source the report reads.
const secrets = {
  anthropic: 'sk-ant-api03-PLANTEDanthropicKEY0123456789abcdefABCDEF',
  openai: 'sk-proj-PLANTEDopenaiKEY0123456789abcdefABCDEF0123',
  github: 'ghp_PLANTEDgithubTOKEN0123456789abcdefABCD',
  bearer: 'PLANTEDbearerVALUE0123456789',
  password: 'PLANTEDpasswordVALUE',
}
const transcriptMarker = 'zebra-transcript-marker'

function plantedRecords(count: number) {
  const secretFields = {
    token: secrets.github,
    api_key: secrets.openai,
    prompt: `${transcriptMarker} please`,
    message: `Authorization: Bearer ${secrets.bearer}`,
    env: { ANTHROPIC_API_KEY: secrets.anthropic },
    url: `https://user:${secrets.password}@example.invalid/repo.git`,
  }
  const records: unknown[] = []
  for (let index = 0; index < count; index++) {
    const second = String(index % 60).padStart(2, '0')
    records.push({
      timestamp: `2026-09-26T10:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${second}.000Z`,
      level: 'INFO',
      target: `ade::${secrets.github}`,
      fields: { event: 'rpc_failed', process: 'daemon', pid: 4242, operation_family: 'agent', ...secretFields },
    })
  }
  records.push({
    timestamp: '2026-09-26T11:00:00.000Z',
    fields: { event: 'secret_dump', process: 'daemon', token: secrets.anthropic },
  })
  return records
}

test('an export is bounded, correlated and contains no planted credential or transcript', async ({ ade, repo }) => {
  const profile = await ade.profile({
    env: { ANTHROPIC_API_KEY: secrets.anthropic, OPENAI_API_KEY: secrets.openai, GITHUB_TOKEN: secrets.github },
  })
  // Transcript and credential text in a Conversation, a draft and a service's environment.
  const { conversationId } = await startConversation(profile, 'codex', repo.path)
  await send(profile, conversationId, `${transcriptMarker} deploy with ${secrets.anthropic}`)
  await waitForIdle(profile, conversationId)
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: 'diag-window',
    revision: 1,
    text: `${transcriptMarker} draft ${secrets.github}`,
    attachments: [],
  })
  const web = await startService(profile, repo.path, 'web', {
    API_TOKEN: secrets.github,
    DB_PASSWORD: secrets.password,
  })
  const { account } = await profile.call('account.create', { provider: 'codex', name: 'Diagnostics account' })
  await writeFile(join(account.native_home, 'auth.json'), JSON.stringify({ token: secrets.openai }))
  // Log records carrying secrets in allow-listed and other fields, and an event outside the allow-list.
  await plantDiagnosticLog(profile, 'planted', '2026-09-26', 0, plantedRecords(3))

  const bundle = await profile.call('diagnostics.export', {})
  const text = JSON.stringify(bundle)
  for (const secret of [...Object.values(secrets), transcriptMarker, profile.home, repo.path]) {
    expect(text, `the export must not contain ${secret}`).not.toContain(secret)
  }
  expect(bundle.format).toBe('ade-diagnostics-v1')
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(bundle.max_bytes)
  expect(bundle.max_bytes).toBe(1024 * 1024)
  expect(bundle.excluded.join('\n')).toMatch(/credentials/)
  expect(bundle.excluded.join('\n')).toMatch(/transcripts/)
  expect(bundle.redaction.policy.length).toBeGreaterThan(0)

  // Correlation: host, profile, boot, runtime incarnation and the live attempts.
  expect(bundle.status.identity).toMatchObject({
    boot_id: profile.hello.boot_id,
    daemon_pid: profile.hello.pid,
    runtime_instance: profile.hello.runtime_instance,
    runtime_pid: profile.hello.runtime_pid,
  })
  expect(bundle.status.live.services.find((entry) => entry.name === 'web')?.last_run_transfer_id).toBe(
    web.started.service.terminal_owner!.transfer_id,
  )

  // Only allow-listed events and fields survive, with their safe values.
  const planted = bundle.events.filter((event) => (event as { pid?: number }).pid === 4242)
  expect(planted).toHaveLength(3)
  for (const event of planted) {
    expect(Object.keys(event as object).sort()).toEqual(['event', 'operation_family', 'pid', 'process', 'timestamp'])
    expect(event).toMatchObject({ event: 'rpc_failed', process: 'daemon', operation_family: 'agent' })
  }
  expect(bundle.events.some((event) => (event as { event?: string }).event === 'secret_dump')).toBe(false)

  // The status query applies the same redaction.
  const report = JSON.stringify(await profile.call('diagnostics.status', {}))
  for (const secret of [...Object.values(secrets), transcriptMarker]) expect(report).not.toContain(secret)

  // The CLI writes a new private file and never overwrites one.
  const output = join(ade.root, 'bundle.json')
  const cli = await profile.cli('diagnostics', 'export', '--output', output, '--events', '10')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'diagnostics_exported', path: output, events_truncated: expect.any(Boolean) })
  expect((await stat(output)).mode & 0o777).toBe(0o600)
  const written = await readFile(output, 'utf8')
  expect(JSON.parse(written)).toMatchObject({ format: 'ade-diagnostics-v1' })
  for (const secret of [...Object.values(secrets), transcriptMarker]) expect(written).not.toContain(secret)
  const again = await profile.cli('diagnostics', 'export', '--output', output)
  expect(again.code).not.toBe(0)
  expect(String(again.json?.message)).toMatch(/never overwrites/)
  expect(await readFile(output, 'utf8')).toBe(written)
  await profile.call('service.stop', { workspace_id: web.workspace.id, name: 'web' })
})

test('the export stays within its event and byte bounds and refuses larger requests', async ({ profile }) => {
  // More records than any request may return, in a file larger than the tail each file contributes.
  await plantDiagnosticLog(profile, 'planted', '2026-09-26', 0, plantedRecords(3_000))

  const bounded = await profile.call('diagnostics.export', { max_events: 1000 })
  expect(bounded.events.length).toBeLessThanOrEqual(1000)
  expect(bounded.events.length).toBeGreaterThan(0)
  expect(bounded.events_truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(bounded.max_bytes)
  // Oldest first, newest kept.
  const stamps = bounded.events.map((event) => String((event as { timestamp?: string }).timestamp ?? ''))
  expect([...stamps].sort()).toEqual(stamps)

  const few = await profile.call('diagnostics.export', { max_events: 5 })
  expect(few.events).toHaveLength(5)
  expect(few.events_truncated).toBe(true)
  const none = await profile.call('diagnostics.export', { max_events: 0 })
  expect(none.events).toEqual([])

  // Out-of-bound requests are refused by the SDK contract, the daemon and the CLI.
  await expect(profile.call('diagnostics.export', { max_events: 5000 })).rejects.toThrow()
  await expect(profile.rpc({ op: 'diagnostics.export', max_events: 5000 })).rejects.toThrow(/at most 1000/)
  const cli = await profile.cli('diagnostics', 'export', '--events', '5000')
  expect(cli.code).not.toBe(0)
})

/** A raw feed subscriber that never reads after subscribing. */
function stalledSubscriber(socketPath: string): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = createConnection(socketPath)
    socket.once('error', rejectSocket)
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ op: 'session.subscribe' })}\n`)
      socket.once('data', () => {
        socket.pause()
        resolveSocket(socket)
      })
    })
  })
}

test('a subscriber that stops reading is evicted and counted, and the feed keeps serving others', async ({
  profile,
}) => {
  test.setTimeout(90_000)
  const stalled = await stalledSubscriber(profile.socket)
  try {
    await expect
      .poll(async () => (await status(profile)).queues.find((queue) => queue.name === 'feed.subscribers')?.depth)
      .toBeGreaterThanOrEqual(1)
    const evictions = async () =>
      (await status(profile)).counters.find((counter) => counter.name === 'feed.subscribers_evicted')
    expect(await evictions()).toMatchObject({ kind: 'dropped', value: 0, window: 'daemon_boot' })

    // Each turn publishes Conversation frames that carry its messages. Take
    // turns until the stalled connection's buffers fill; its next write times
    // out, and the daemon evicts it and counts the eviction.
    const { conversationId } = await startConversation(profile, 'codex')
    let turns = 0
    await expect
      .poll(
        async () => {
          turns += 1
          await send(profile, conversationId, `${'y'.repeat(16_384)} turn ${turns}`)
          await waitForIdle(profile, conversationId)
          return (await evictions())?.value ?? 0
        },
        { timeout: 60_000, intervals: [0] },
      )
      .toBe(1)
    await expect
      .poll(async () => (await status(profile)).queues.find((queue) => queue.name === 'feed.subscribers')?.depth)
      .toBe(0)
    expect(await evictions()).toMatchObject({ provenance: 'approximate' })

    // The daemon keeps answering and a fresh turn still completes.
    await send(profile, conversationId, prompts.turn)
    await waitForIdle(profile, conversationId)
  } finally {
    stalled.destroy()
  }
  // The counter resets with the daemon, as its window says.
  await profile.restartDaemon()
  expect((await status(profile)).counters.find((counter) => counter.name === 'feed.subscribers_evicted')?.value).toBe(0)
})
