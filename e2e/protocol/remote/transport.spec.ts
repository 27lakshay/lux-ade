// F121, F125 and 11-S08: the client reaches a remote profile daemon only over
// the pinned SSH forward. Workspaces, files, Git and provider processes stay
// on that host. Link loss reports unknown, refuses requests unsent, never
// reaches the local daemon, and reconnects to the same remote runtime, where
// the original turn is still the one running.
import { expect, remoteCall, remoteClient, test } from '../fixtures/remote-hosts'
import { isRunning } from '../fixtures'
import { startedHost, targetOf } from './steps'

function targetArgs(target: ReturnType<typeof targetOf>): string[] {
  return [
    '--host',
    target.hostId,
    '--remote-profile',
    target.profileId,
    '--ssh',
    target.destination,
    '--remote-socket',
    target.remoteSocket,
    '--host-key',
    target.hostPublicKey!,
    '--timeout-ms',
    '15000',
  ]
}

test('a remote workspace flow runs on the host through the CLI and SDK transport and nothing lands locally', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const target = targetOf(started)
  const repo = await started.host.repo('app', { 'README.md': '# Remote app\n', 'src/main.txt': 'remote\n' })

  const status = await profile.cli('remote', 'status', ...targetArgs(target))
  expect(status.code, status.stderr).toBe(0)
  expect(status.json).toMatchObject({
    type: 'remote_status',
    host_id: 'devbox',
    profile_id: started.remoteProfileId,
    hello: { pid: started.daemon.pid, boot_id: started.daemon.boot_id },
  })

  const opened = await profile.cli(
    'remote',
    'request',
    'workspace.open',
    JSON.stringify({ path: repo.path }),
    ...targetArgs(target),
  )
  expect(opened.code, opened.stderr).toBe(0)
  const workspace = opened.json?.workspace as { id: string; root: string }
  expect(workspace.root).toBe(repo.path)

  const transport = await remote.transport(target)
  transport.start()
  await transport.waitUntilConnected(15_000)
  const files = await remoteCall(transport, 'file.list', { workspace_id: workspace.id })
  expect(JSON.stringify(files)).toContain('README.md')
  await repo.dirty('src/main.txt', 'changed on the host\n')
  const review = await remoteCall(transport, 'review.status', { workspace_id: workspace.id, force: true })
  expect(JSON.stringify(review)).toContain('src/main.txt')

  // A provider turn runs on the host with the host's own provider.
  const { conversation } = await remoteCall(transport, 'conversation.create', {
    workspace_id: workspace.id,
    provider: 'codex',
  })
  await remoteCall(transport, 'agent.send', {
    conversation_id: conversation.id,
    request_id: 'remote-turn-1',
    text: 'hello',
  })
  await expect
    .poll(
      async () =>
        JSON.stringify(
          (await remoteCall(transport, 'conversation.get', { conversation_id: conversation.id })).messages,
        ),
      { timeout: 20_000 },
    )
    .toContain('Hello world')
  expect((await started.host.mockCalls('codex')).some((call) => call.method === 'turn/start')).toBe(true)

  // The profile records where the work lives; its own tables hold none of it.
  await profile.call('placement.record', {
    host: { kind: 'remote', host_id: 'devbox' },
    resource: { kind: 'workspace', workspace_id: workspace.id },
  })
  await profile.call('placement.record', {
    host: { kind: 'remote', host_id: 'devbox' },
    resource: { kind: 'conversation', workspace_id: workspace.id, conversation_id: conversation.id },
  })
  expect(
    (
      await profile.call('placement.resolve', {
        resource: { kind: 'conversation', workspace_id: workspace.id, conversation_id: conversation.id },
      })
    ).placement,
  ).toMatchObject({ host: { kind: 'remote', host_id: 'devbox' }, source: 'recorded' })
  const local = await profile.call('catalog.get', {})
  expect(JSON.stringify(local.catalog)).not.toContain(workspace.id)
  expect(JSON.stringify(local.catalog)).not.toContain(repo.path)
  expect(await profile.mockCalls('codex')).toEqual([])
  const remoteCatalog = await remoteCall(transport, 'catalog.get', {})
  expect(remoteCatalog.catalog.workspaces.map((entry) => entry.id)).toContain(workspace.id)
  expect(remoteCatalog.boot_id).toBe(started.daemon.boot_id)
})

test('link loss during a turn reports unknown, sends nothing anywhere else, and reconnects to the original attempt', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const target = targetOf(started)
  const transport = await remote.transport(target)
  const { remoteStatus } = await remoteClient()
  const phases: string[] = []
  transport.subscribe((state) => phases.push(state.phase))
  transport.start()
  const connected = await transport.waitUntilConnected(15_000)
  const pinned = connected.pinned

  const { workspace } = await remoteCall(transport, 'workspace.open', { path: started.host.home })
  const { conversation } = await remoteCall(transport, 'conversation.create', {
    workspace_id: workspace.id,
    provider: 'codex',
  })
  await remoteCall(transport, 'agent.send', { conversation_id: conversation.id, request_id: 'held-turn', text: 'hold' })
  await expect
    .poll(
      async () =>
        (await remoteCall(transport, 'conversation.get', { conversation_id: conversation.id })).conversation.status,
    )
    .toBe('running')
  const turnsBefore = (await started.host.mockCalls('codex')).filter((call) => call.method === 'turn/start').length
  expect(turnsBefore).toBe(1)

  await started.host.linkDown()
  await expect.poll(() => remoteStatus(transport.getState())).toBe('unknown')
  expect(transport.getState().detail).toContain('unknown')
  // Requests are refused unsent while the state is unknown; nothing is sent elsewhere.
  await expect(remoteCall(transport, 'conversation.get', { conversation_id: conversation.id })).rejects.toMatchObject({
    code: 'unavailable',
    delivery: 'not_sent',
  })
  await expect(
    remoteCall(transport, 'agent.send', { conversation_id: conversation.id, request_id: 'during-loss', text: 'hello' }),
  ).rejects.toMatchObject({ code: 'unavailable', delivery: 'not_sent' })
  const cli = await profile.cli('remote', 'status', ...targetArgs(target).slice(0, -2), '--timeout-ms', '2000')
  expect(cli.code).not.toBe(0)
  expect(cli.stdout + cli.stderr).not.toContain(String(profile.hello.pid))
  // The local profile gained no conversation or workspace and its providers were never called.
  const local = await profile.call('catalog.get', {})
  expect(JSON.stringify(local.catalog)).not.toContain(conversation.id)
  expect(await profile.mockCalls('codex')).toEqual([])
  // The remote turn keeps running on the host.
  expect(await isRunning(started.daemon.pid)).toBe(true)

  await started.host.linkUp()
  await expect.poll(() => transport.getState().phase, { timeout: 30_000 }).toBe('connected')
  expect(transport.getState().pinned).toEqual(pinned)
  expect(transport.getState().current?.runtimeSocket).toBe(pinned?.runtimeSocket)
  expect(phases).toContain('unknown')

  // The original attempt is the one still running, with no duplicate turn.
  const after = await remoteCall(transport, 'conversation.get', { conversation_id: conversation.id })
  expect(after.conversation.status).toBe('running')
  const turns = (await started.host.mockCalls('codex')).filter((call) => call.method === 'turn/start')
  expect(turns).toHaveLength(1)
  await remoteCall(transport, 'agent.cancel', { conversation_id: conversation.id })
  await expect
    .poll(
      async () =>
        (await remoteCall(transport, 'conversation.get', { conversation_id: conversation.id })).conversation.status,
      { timeout: 20_000 },
    )
    .toBe('interrupted')
})

test('a remote daemon crash is reported unknown and the transport reconnects to the same runtime after a restart', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const transport = await remote.transport(targetOf(started))
  transport.start()
  const first = await transport.waitUntilConnected(15_000)

  process.kill(started.daemon.pid, 'SIGKILL')
  await expect.poll(() => isRunning(started.daemon.pid)).toBe(false)
  // The forward is up, but the daemon behind it is gone: the reply is lost, not local.
  await expect(transport.request('catalog.get')).rejects.toMatchObject({ code: 'unavailable' })
  expect(['unknown', 'forwarding', 'handshaking']).toContain(transport.getState().phase)

  const restarted = await profile.call(
    'remote.host.start',
    { host_id: 'devbox', operation_id: `e2e-remote-restart-${process.pid}` },
    { timeoutMs: 120_000 },
  )
  expect(restarted.outcome).toBe('running')
  await expect.poll(() => transport.getState().phase, { timeout: 30_000 }).toBe('connected')
  const state = transport.getState()
  expect(state.current?.bootId).toBe(restarted.daemon!.boot_id)
  expect(state.current?.bootId).not.toBe(first.current?.bootId)
  expect(state.current?.runtimeSocket).toBe(first.pinned?.runtimeSocket)
})
