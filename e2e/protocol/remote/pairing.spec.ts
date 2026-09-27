// F121 and F122: explicit pairing, revocation, and an authenticated endpoint.
// A pairing records where its token lives, never the token. Revocation makes
// this profile refuse to start, attach, place work on or preview the host,
// and leaves the work already on the host running. The remote daemon listens
// only on an owner-only Unix socket that ssh forwards; it opens no TCP port.
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { expect, remoteCall, test } from '../fixtures/remote-hosts'
import { isRunning } from '../fixtures'
import { addAndPair, operationId, startedHost, targetOf } from './steps'

const execFileAsync = promisify(execFile)

test('pairing is explicit, revocation refuses start, placement and preview, and remote work keeps running', async ({ remote }) => {
  const profile = await remote.profile()
  const host = await remote.host('devbox')
  const remoteProfileId = await host.createProfile()
  await profile.call('remote.host.add', { host_id: 'devbox', ssh_target: 'devbox',
    expected_fingerprint: host.hostKey.fingerprint, remote_profile_id: remoteProfileId })

  // Unpaired: nothing starts and nothing runs on the host.
  const unpaired = await profile.cli('remote', 'start', 'devbox', '--request-id', operationId('unpaired'))
  expect(unpaired.code).not.toBe(0)
  expect(unpaired.json?.message).toContain('devbox is not paired')
  expect((await remote.calls()).some((call) => call.remote_command !== undefined)).toBe(false)

  // Only a reference to the token is stored; a raw token is refused.
  const raw = await profile.cli('remote', 'pair', 'devbox', '--token-env', 'not-a-variable-name')
  expect(raw.code).not.toBe(0)
  const paired = await profile.cli('remote', 'pair', 'devbox', '--token-env', 'ADE_DEVBOX_TOKEN')
  expect(paired.code).toBe(0)
  expect(paired.json).toMatchObject({ host_id: 'devbox', enforcement: 'local_profile',
    pairing: { state: 'active', token_reference: { env: 'ADE_DEVBOX_TOKEN' }, revoked_at_ms: null } })
  const pairingId = (paired.json?.pairing as { pairing_id: string }).pairing_id
  // Pairing again with the same reference converges; another reference is refused while one is active.
  const repeat = await profile.call('remote.host.pair', { host_id: 'devbox', token_reference: { env: 'ADE_DEVBOX_TOKEN' } })
  expect(repeat.pairing.pairing_id).toBe(pairingId)
  await expect(profile.call('remote.host.pair', { host_id: 'devbox', token_reference: { env: 'ADE_OTHER_TOKEN' } }))
    .rejects.toThrow(/already has active pairing/)

  const started = await profile.call('remote.host.start', { host_id: 'devbox', operation_id: operationId('paired') },
    { timeoutMs: 120_000 })
  expect(started.outcome).toBe('running')
  const daemon = started.daemon!

  // Remote work: a workspace opened on the host through the SDK transport.
  const registered = (await profile.call('remote.host.list', {})).hosts[0]
  const transport = await remote.transport({ hostId: 'devbox', profileId: remoteProfileId, destination: 'devbox',
    remoteSocket: daemon.socket, hostPublicKey: registered.host_public_key })
  transport.start()
  await transport.waitUntilConnected(15_000)
  const repo = await host.repo('app')
  const opened = await remoteCall(transport, 'workspace.open', { path: repo.path })
  await profile.call('placement.record', { host: { kind: 'remote', host_id: 'devbox' },
    resource: { kind: 'workspace', workspace_id: opened.workspace.id } })
  transport.stop()

  // A host with an active pairing cannot be removed.
  await expect(profile.call('remote.host.remove', { host_id: 'devbox' })).rejects.toThrow(/Revoke pairing/)

  const revoked = await profile.cli('remote', 'revoke', 'devbox', pairingId)
  expect(revoked.code).toBe(0)
  expect(revoked.json).toMatchObject({ pairing: { pairing_id: pairingId, state: 'revoked' } })
  // Revoking again converges.
  const again = await profile.call('remote.host.revoke', { host_id: 'devbox', pairing_id: pairingId })
  expect(again.pairing.state).toBe('revoked')

  // Revocation survives a daemon crash.
  await profile.restartDaemon('kill')
  expect((await profile.call('remote.host.list', {})).hosts[0].pairing).toMatchObject({ pairing_id: pairingId,
    state: 'revoked' })

  const commandsBefore = (await remote.calls()).length
  const refusedStart = await profile.cli('remote', 'start', 'devbox', '--request-id', operationId('revoked'))
  expect(refusedStart.code).not.toBe(0)
  expect(refusedStart.json?.message).toContain(`Pairing ${pairingId} with devbox was revoked`)
  const check = await profile.call('placement.check', { host: { kind: 'remote', host_id: 'devbox' },
    resource: 'conversation', workspace_id: opened.workspace.id })
  expect(check).toMatchObject({ admitted: false, host: { kind: 'remote', host_id: 'devbox' } })
  expect(check.reason).toMatch(/revoked/i)
  const entry = (await profile.call('placement.hosts', {})).hosts.find((candidate) => candidate.host.kind === 'remote')
  expect(entry?.readiness).not.toBe('started')
  const preview = await profile.cli('placement', 'preview', 'devbox', 'http://127.0.0.1:5173/')
  expect(preview.code).toBe(0)
  expect(preview.json).toMatchObject({ preview: { available: false, host: { kind: 'remote', host_id: 'devbox' } } })
  // None of these reached the host.
  expect((await remote.calls()).length).toBe(commandsBefore)

  // The work on the host is untouched: its daemon runs and still holds the workspace.
  expect(await isRunning(daemon.pid)).toBe(true)
  const status = await host.daemonStatus(remoteProfileId)
  expect(status?.daemon).toMatchObject({ pid: daemon.pid })
  expect((await host.control('runtime', 'status', '--home', host.runtimeHome(remoteProfileId))).code).toBe(0)
  expect((await profile.call('placement.resolve', { resource: { kind: 'workspace', workspace_id: opened.workspace.id } }))
    .placement.host).toEqual({ kind: 'remote', host_id: 'devbox' })

  // The host stays registered while its placements are recorded; pairing again is a new, explicit pairing.
  await expect(profile.call('remote.host.remove', { host_id: 'devbox' })).rejects.toThrow(/recorded placement/)
  const repaired = await profile.call('remote.host.pair', { host_id: 'devbox', token_reference: { env: 'ADE_DEVBOX_TOKEN' } })
  expect(repaired.pairing.pairing_id).not.toBe(pairingId)
  expect(repaired.pairing.state).toBe('active')
})

test('the remote daemon listens only on an owner-only Unix socket reached through the pinned SSH forward', async ({ remote }) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')

  // No TCP listener on the remote daemon or its runtime.
  const runtimePid = (await started.host.daemonHello(started.remoteProfileId))?.runtime_pid as number
  for (const pid of [started.daemon.pid, runtimePid]) {
    const listening = await execFileAsync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'])
      .then(({ stdout }) => stdout.trim(), () => '')
    expect(listening).toBe('')
  }
  const socket = await stat(started.daemon.socket)
  expect(socket.isSocket()).toBe(true)
  expect(socket.uid).toBe(process.getuid!())
  expect(socket.mode & 0o077).toBe(0)

  // The client transport reaches it only through ssh with the pinned key and an owner-only local socket.
  const transport = await remote.transport(targetOf(started))
  transport.start()
  const state = await transport.waitUntilConnected(15_000)
  expect(state.current?.runtimeSocket).toBe(
    (await started.host.daemonHello(started.remoteProfileId))?.runtime_socket)
  const forward = (await remote.calls()).find((call) => call.forwarding)!
  expect(forward.args).toEqual(expect.arrayContaining(['-N', 'StrictHostKeyChecking=yes', 'BatchMode=yes',
    'HostKeyAlias=ade-remote-devbox', 'GlobalKnownHostsFile=/dev/null', 'StreamLocalBindMask=0177',
    'ExitOnForwardFailure=yes', 'ControlPath=none', '--', 'devbox']))
  const local = forward.forwarding![0].split(':')[0]
  expect(forward.forwarding![0]).toBe(`${local}:${started.daemon.socket}`)
  expect((await stat(local)).mode & 0o077).toBe(0)
  const hello = await transport.request('hello')
  expect(hello).toMatchObject({ pid: started.daemon.pid, boot_id: started.daemon.boot_id })
  expect(hello.pid).not.toBe(profile.hello.pid)

  // An unpinned target with no known_hosts entry is refused: nothing is trusted on first use.
  const unpinned = await remote.transport({ ...targetOf(started), hostId: 'devbox-unpinned', hostPublicKey: null })
  unpinned.start()
  await expect(unpinned.waitUntilConnected(10_000)).rejects.toMatchObject({ code: 'unavailable' })
  expect(unpinned.getState()).toMatchObject({ phase: 'failed', failure: 'host_untrusted' })
})

// Gap: the remote backend does not issue or verify pairing tokens yet. A
// revoked pairing is enforced only by this profile (`enforcement:
// "local_profile"`); a client holding SSH access to the host can still reach
// the remote daemon over the forward after revocation. F122's "reject
// subsequent reconnections" needs a remote grant store and token presentation
// on connect.
test.fixme('the remote daemon rejects a connection that presents a revoked pairing', async ({ remote }) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  await profile.call('remote.host.revoke', { host_id: 'devbox', pairing_id: started.pairing.pairing_id })
  const transport = await remote.transport(targetOf(started))
  transport.start()
  await expect(transport.waitUntilConnected(10_000)).rejects.toThrow()
})

test('a pairing is recorded for an explicit host only and revoking an unknown pairing is refused', async ({ remote }) => {
  const profile = await remote.profile()
  const host = await remote.host('devbox')
  await expect(profile.call('remote.host.pair', { host_id: 'ghost', token_reference: { env: 'ADE_GHOST_TOKEN' } }))
    .rejects.toThrow(/Unknown remote host ghost/)
  const { pairing } = await addAndPair(profile, host, 'devbox')
  await expect(profile.call('remote.host.revoke', { host_id: 'devbox', pairing_id: 'not-a-pairing' }))
    .rejects.toThrow(/Unknown pairing/)
  expect((await profile.call('remote.host.list', {})).hosts[0].pairing).toMatchObject({ pairing_id: pairing.pairing_id,
    state: 'active' })
})
