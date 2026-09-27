// F124: SSH bootstrap. Host identity is pinned from an out-of-band
// fingerprint, never learned; a changed key is refused before anything runs on
// the host; missing backend artifacts are reported and installed only by the
// explicit install operation, into ADE's own directory; the remote profile
// daemon is started or attached without copying credentials or touching
// unrelated configuration; a start whose outcome is uncertain is never
// replayed blindly.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { binaries } from '../fixtures/environment'
import { expect, generateHostKey, test } from '../fixtures/remote-hosts'
import { isRunning } from '../fixtures'
import { addAndPair, operationId, startedHost, startRunning } from './steps'

test('host add pins only the key matching the out-of-band fingerprint and records nothing on a mismatch', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const host = await remote.host('devbox')

  const wrong = generateHostKey().fingerprint
  const refused = await profile.cli('remote', 'add', 'devbox', 'devbox', wrong)
  expect(refused.code).not.toBe(0)
  expect(refused.json?.message).toContain(`No host key matches ${wrong}`)
  expect(refused.json?.message).toContain(host.hostKey.fingerprint)
  expect(refused.json?.message).toContain('Nothing was recorded')
  expect((await profile.call('remote.host.list', {})).hosts).toEqual([])

  // The key comes from ssh -G and ssh-keyscan; only the matching one is pinned.
  const added = await profile.call('remote.host.add', {
    host_id: 'devbox',
    ssh_target: 'devbox',
    expected_fingerprint: host.hostKey.fingerprint,
    label: 'Dev box',
  })
  expect(added.host).toMatchObject({
    host_id: 'devbox',
    label: 'Dev box',
    ssh_target: 'devbox',
    host_key_type: 'ssh-ed25519',
    host_key_fingerprint: host.hostKey.fingerprint,
    host_public_key: host.hostKey.line,
    pairing: null,
  })
  const calls = await remote.calls()
  expect(calls.map((call) => call.program)).toEqual(expect.arrayContaining(['ssh', 'ssh-keyscan']))
  expect(calls.some((call) => call.remote_command !== undefined)).toBe(false)

  // Idempotent: the same definition returns the stored host; a different one is refused.
  const again = await profile.call('remote.host.add', {
    host_id: 'devbox',
    ssh_target: 'devbox',
    expected_fingerprint: host.hostKey.fingerprint,
    label: 'Dev box',
  })
  expect(again.host).toEqual(added.host)
  const conflicting = await profile.cli(
    'remote',
    'add',
    'devbox',
    'devbox',
    host.hostKey.fingerprint,
    '--label',
    'Other',
  )
  expect(conflicting.code).not.toBe(0)
  expect(conflicting.json?.message).toContain('registered with a different definition')

  // The registry survives a daemon restart.
  await profile.restartDaemon('kill')
  expect((await profile.call('remote.host.list', {})).hosts).toEqual([added.host])

  // `local` names this machine and is never a remote host ID.
  const local = await profile.cli('remote', 'add', 'local', 'devbox', host.hostKey.fingerprint)
  expect(local.code).not.toBe(0)
  expect(local.json?.message).toContain('reserved')
})

test('a changed host key is refused before anything runs on the host, for probe, start and the client transport', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const commandsBefore = (await remote.calls()).filter((call) => call.remote_command !== undefined).length

  const rotated = await started.host.changeHostKey()
  expect(rotated.fingerprint).not.toBe(started.registered.host_key_fingerprint)

  const probe = await profile.cli('remote', 'probe', 'devbox')
  expect(probe.code).not.toBe(0)
  expect(probe.json?.message).toContain('did not present the pinned host key')
  expect(probe.json?.message).toContain(started.registered.host_key_fingerprint)

  const start = await profile.cli('remote', 'start', 'devbox', '--request-id', operationId('rotated'))
  expect(start.code).not.toBe(0)
  expect(start.json).toMatchObject({ code: 'not_applied' })
  expect(start.json?.message).toMatch(/did not present the pinned (host )?key.*nothing ran on it/)

  // Nothing ran on the host after the key changed.
  const commandsAfter = (await remote.calls()).filter((call) => call.remote_command !== undefined).length
  expect(commandsAfter).toBe(commandsBefore)
  const refusals = (await remote.calls()).filter((call) => /Host key verification failed/.test(call.stderr ?? ''))
  expect(refusals.length).toBeGreaterThanOrEqual(2)
  for (const call of refusals) {
    expect(call.args).toEqual(
      expect.arrayContaining([
        'StrictHostKeyChecking=yes',
        'GlobalKnownHostsFile=/dev/null',
        'HostKeyAlias=ade-remote-devbox',
        'ControlPath=none',
        'ForwardAgent=no',
      ]),
    )
  }

  // The SDK transport pinned to the registered key also refuses and stops retrying.
  const transport = await remote.transport({
    hostId: 'devbox',
    profileId: started.remoteProfileId,
    destination: 'devbox',
    remoteSocket: started.daemon.socket,
    hostPublicKey: started.registered.host_public_key,
  })
  transport.start()
  await expect(transport.waitUntilConnected(10_000)).rejects.toMatchObject({ code: 'unavailable' })
  expect(transport.getState()).toMatchObject({ phase: 'failed', failure: 'host_untrusted' })

  // Re-adding under the same ID with the new fingerprint is refused as a different definition.
  const readd = await profile.cli('remote', 'add', 'devbox', 'devbox', rotated.fingerprint)
  expect(readd.code).not.toBe(0)
  expect(readd.json?.message).toContain('different definition')
  // The remote daemon is left running: a key change is not permission to stop remote work.
  expect(await isRunning(started.daemon.pid)).toBe(true)

  // Rotation is explicit: revoke, remove, then add the key verified out of band. The host
  // reattaches to the daemon that kept running.
  await profile.call('remote.host.revoke', { host_id: 'devbox', pairing_id: started.pairing.pairing_id })
  expect((await profile.call('remote.host.remove', { host_id: 'devbox' })).removed).toBe(true)
  const { host: readded } = await addAndPair(profile, started.host, 'devbox', {
    remoteProfileId: started.remoteProfileId,
  })
  expect(readded.host_key_fingerprint).toBe(rotated.fingerprint)
  const reattached = await startRunning(profile, 'devbox')
  expect(reattached.daemon).toMatchObject({ pid: started.daemon.pid, boot_id: started.daemon.boot_id })
})

test('a duplicate start while the first is in flight is not run twice', async ({ remote }) => {
  const profile = await remote.profile()
  const host = await remote.host('devbox')
  const remoteProfileId = await host.createProfile()
  await addAndPair(profile, host, 'devbox', { remoteProfileId })

  await host.holdCommands()
  const id = operationId('duplicate')
  const first = profile.call('remote.host.start', { host_id: 'devbox', operation_id: id }, { timeoutMs: 120_000 })
  await expect.poll(async () => (await remote.calls()).filter((call) => call.held !== undefined).length).toBe(1)
  const duplicate = await profile.call(
    'remote.host.start',
    { host_id: 'devbox', operation_id: id },
    { timeoutMs: 120_000 },
  )
  expect(duplicate).toMatchObject({ outcome: 'unknown', operation_id: id })
  expect(duplicate.detail).toContain('may still be running')
  await host.releaseCommands()
  const settled = await first
  expect(settled.outcome).toBe('running')
  // Only the first attempt ran on the host, and a later replay returns its result.
  expect((await remote.calls()).filter((call) => call.held !== undefined)).toHaveLength(1)
  expect(await profile.call('remote.host.start', { host_id: 'devbox', operation_id: id })).toEqual(settled)
  expect((await host.processes()).filter((row) => row.command.includes('/ade-daemon')).map((row) => row.pid)).toEqual([
    settled.daemon!.pid,
  ])
})

test('bootstrap names the missing backend artifacts and installs and starts nothing', async ({ remote }) => {
  const profile = await remote.profile()
  const host = await remote.host('bare', { artifacts: [] })
  await writeFile(join(host.home, '.profile'), 'export EDITOR=vi\n')
  const homeBefore = (await readdir(host.home)).sort()
  await addAndPair(profile, host, 'bare')

  const none = await profile.call('remote.host.probe', { host_id: 'bare' }, { timeoutMs: 75_000 })
  expect(none.backend).toMatchObject({ compatible: false, control_path: null })
  expect(none.backend.missing).toEqual([
    expect.stringContaining('ade-control is not on the remote non-interactive PATH'),
  ])
  expect(none.platform.os).toBe(process.platform === 'darwin' ? 'Darwin' : 'Linux')

  await host.install(['ade-control'])
  const partial = await profile.call('remote.host.probe', { host_id: 'bare' }, { timeoutMs: 75_000 })
  expect(partial.backend.compatible).toBe(false)
  expect(partial.backend.application_protocol).toBe('ade-application-v1')
  expect(partial.backend.missing).toEqual([
    `an executable ade-daemon beside ${join(host.binDirectory, 'ade-control')}`,
    `an executable ade-runtime beside ${join(host.binDirectory, 'ade-control')}`,
  ])

  const start = await profile.call(
    'remote.host.start',
    { host_id: 'bare', operation_id: operationId('bare') },
    { timeoutMs: 120_000 },
  )
  expect(start.outcome).toBe('failed')
  expect(start.detail).toContain('missing an executable ade-daemon')
  expect(start.detail).toContain('nothing was installed or started')
  expect(start.daemon ?? null).toBeNull()

  // Nothing was installed, started or written on the host.
  expect((await readdir(host.binDirectory)).sort()).toEqual(['ade-control'])
  expect(await host.processes()).toEqual([])
  expect((await readdir(host.home)).sort()).toEqual(homeBefore)
  expect(await readFile(join(host.home, '.profile'), 'utf8')).toBe('export EDITOR=vi\n')
  const hosts = await profile.call('placement.hosts', {})
  expect(hosts.hosts.find((entry) => entry.host.kind === 'remote')).toMatchObject({ readiness: 'unavailable' })
})

test('start launches the remote profile daemon on the host, attaches on reconnect and replays a repeated operation ID', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const host = await remote.host('devbox')
  await writeFile(join(host.home, '.profile'), 'export EDITOR=vi\n')
  const remoteProfileId = await host.createProfile()
  await addAndPair(profile, host, 'devbox', { remoteProfileId })

  const first = operationId('first')
  const started = await startRunning(profile, 'devbox', first)
  const daemon = started.daemon!
  expect(daemon).toMatchObject({ profile_id: remoteProfileId, application_protocol: 'ade-application-v1' })
  // The daemon runs the host's own installed executable, with the host's own home.
  const remoteDaemon = await host.daemonHello(remoteProfileId)
  expect(remoteDaemon).toMatchObject({ pid: daemon.pid, boot_id: daemon.boot_id })
  expect((await host.processes()).map((row) => row.pid)).toContain(daemon.pid)
  expect(daemon.pid).not.toBe(profile.hello.pid)

  // A repeated operation ID replays the stored reply and runs nothing on the host.
  const commands = (await remote.calls()).filter((call) => call.remote_command !== undefined).length
  const replay = await profile.call(
    'remote.host.start',
    { host_id: 'devbox', operation_id: first },
    { timeoutMs: 120_000 },
  )
  expect(replay).toEqual(started)
  expect((await remote.calls()).filter((call) => call.remote_command !== undefined).length).toBe(commands)
  // The same ID with other parameters is a conflict.
  await addAndPair(profile, await remote.host('other'), 'other')
  await expect(profile.call('remote.host.start', { host_id: 'other', operation_id: first })).rejects.toThrow(
    /already used for different parameters/,
  )

  // A new start attaches to the running daemon instead of launching another.
  const attached = await startRunning(profile, 'devbox')
  expect(attached.daemon).toMatchObject({ pid: daemon.pid, boot_id: daemon.boot_id })

  // The remote daemon crashes; the next start launches a new one and the runtime survives.
  process.kill(daemon.pid, 'SIGKILL')
  await expect.poll(() => isRunning(daemon.pid)).toBe(false)
  const relaunched = await startRunning(profile, 'devbox')
  expect(relaunched.daemon!.boot_id).not.toBe(daemon.boot_id)
  expect(relaunched.daemon!.socket).toBe(daemon.socket)

  // No credentials were forwarded and no unrelated configuration was touched.
  for (const call of (await remote.calls()).filter((entry) => entry.remote_command !== undefined)) {
    expect(call.args).toEqual(
      expect.arrayContaining([
        'BatchMode=yes',
        'ForwardAgent=no',
        'ForwardX11=no',
        'ClearAllForwardings=yes',
        'PermitLocalCommand=no',
      ]),
    )
  }
  expect(await readFile(join(host.home, '.profile'), 'utf8')).toBe('export EDITOR=vi\n')
  expect(await readdir(join(host.home))).not.toContain('.ssh')
  await expect(readdir(join(profile.home, '.ssh'))).rejects.toThrow()
})

test('a start interrupted by a local daemon crash is not replayed and says to keep the same operation ID', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const host = await remote.host('devbox')
  const remoteProfileId = await host.createProfile()
  await addAndPair(profile, host, 'devbox', { remoteProfileId })

  await host.holdCommands()
  const id = operationId('crash')
  const pending = profile
    .call('remote.host.start', { host_id: 'devbox', operation_id: id }, { timeoutMs: 120_000 })
    .catch((error: unknown) => error)
  await expect.poll(async () => (await remote.calls()).some((call) => call.held !== undefined)).toBe(true)
  await profile.killDaemon()
  expect(await pending).toBeInstanceOf(Error)
  await host.releaseCommands()
  await profile.restartDaemon()

  const retried = await profile.call(
    'remote.host.start',
    { host_id: 'devbox', operation_id: id },
    { timeoutMs: 120_000 },
  )
  expect(retried.outcome).toBe('unknown')
  expect(retried.detail).toContain('Retry this same operation ID')
  expect(retried.daemon ?? null).toBeNull()
  // A dispatched start with no outcome leaves the host neither ready nor refused as failed.
  const entry = (await profile.call('placement.hosts', {})).hosts.find((candidate) => candidate.host.kind === 'remote')
  expect(entry?.readiness).not.toBe('started')

  // A fresh operation ID reaches the host again and attaches or starts exactly one daemon.
  const fresh = await startRunning(profile, 'devbox')
  const daemons = (await host.processes()).filter((row) => row.command.includes('/ade-daemon'))
  expect(daemons.map((row) => row.pid)).toEqual([fresh.daemon!.pid])
})

const digest = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

test("install copies this backend into ADE's own directory only when asked, then the host starts from it", async ({
  remote,
}) => {
  const profile = await remote.profile()
  const host = await remote.host('bare', { artifacts: [] })
  await writeFile(join(host.home, '.profile'), 'export EDITOR=vi\n')
  await mkdir(join(host.home, '.ssh'))
  await writeFile(join(host.home, '.ssh/authorized_keys'), 'ssh-ed25519 AAAA user@laptop\n')
  await addAndPair(profile, host, 'bare')

  // Probe and start install nothing.
  expect((await profile.call('remote.host.probe', { host_id: 'bare' }, { timeoutMs: 75_000 })).backend.compatible).toBe(
    false,
  )
  expect(await readdir(host.home)).not.toContain('.ade')

  const id = operationId('install')
  const installed = await profile.cli('remote', 'install', 'bare', '--request-id', id)
  expect(installed.code, installed.stderr).toBe(0)
  const directory = join(host.home, '.ade/backend/ade-application-v1+ade-runtime-v8')
  expect(installed.json).toMatchObject({
    type: 'remote_host_install',
    outcome: 'installed',
    host_id: 'bare',
    control_path: join(directory, 'ade-control'),
    installed: ['ade-runtime', 'ade-daemon', 'ade-control'],
  })
  expect(await digest(join(directory, 'ade-daemon'))).toBe(await digest(binaries.daemon))
  expect((await readdir(directory)).sort()).toEqual(['ade-control', 'ade-daemon', 'ade-runtime'])
  // Nothing else on the host changed, and no credentials went over.
  expect(await readFile(join(host.home, '.profile'), 'utf8')).toBe('export EDITOR=vi\n')
  expect(await readdir(join(host.home, '.ssh'))).toEqual(['authorized_keys'])
  expect(await readdir(host.binDirectory)).toEqual([])
  for (const call of (await remote.calls()).filter((entry) => entry.remote_command?.includes('ade-installed'))) {
    expect(call.args).toEqual(
      expect.arrayContaining(['ForwardAgent=no', 'StrictHostKeyChecking=yes', 'HostKeyAlias=ade-remote-bare']),
    )
  }

  // The registry uses the installed backend; the host's definition is unchanged.
  const registered = (await profile.call('remote.host.list', {})).hosts[0]
  expect(registered).toMatchObject({ backend_path: null, installed_backend_path: join(directory, 'ade-control') })
  const probe = await profile.call('remote.host.probe', { host_id: 'bare' }, { timeoutMs: 75_000 })
  expect(probe.backend).toMatchObject({ compatible: true, control_path: join(directory, 'ade-control'), missing: [] })

  // A replay returns the stored reply; installing again writes nothing.
  const uploads = () =>
    remote.calls().then((calls) => calls.filter((call) => call.remote_command?.includes('ade-installed')).length)
  const before = await uploads()
  expect(
    await profile.call('remote.host.install', { host_id: 'bare', operation_id: id }, { timeoutMs: 500_000 }),
  ).toEqual(installed.json)
  const again = await profile.call(
    'remote.host.install',
    { host_id: 'bare', operation_id: operationId('again') },
    { timeoutMs: 500_000 },
  )
  expect(again).toMatchObject({
    outcome: 'already_compatible',
    installed: [],
    control_path: join(directory, 'ade-control'),
  })
  expect(await uploads()).toBe(before)

  // The host now starts its remote profile daemon from the installed backend.
  const remoteProfileId = await host.createProfile('remote', join(directory, 'ade-control'))
  const started = await startRunning(profile, 'bare')
  expect(started.daemon).toMatchObject({ profile_id: remoteProfileId })
  expect((await host.processes()).find((row) => row.pid === started.daemon!.pid)?.command).toContain(
    join(directory, 'ade-daemon'),
  )

  // Removing the host forgets the install record; the installed files stay on the host.
  await profile.call('remote.host.revoke', { host_id: 'bare', pairing_id: registered.pairing!.pairing_id })
  await profile.call('remote.host.remove', { host_id: 'bare' })
  expect((await readdir(directory)).sort()).toEqual(['ade-control', 'ade-daemon', 'ade-runtime'])
})

test('install never replaces a backend the user named and needs a pairing', async ({ remote }) => {
  const profile = await remote.profile()
  const host = await remote.host('named', { artifacts: [] })
  await profile.call('remote.host.add', {
    host_id: 'named',
    ssh_target: 'named',
    expected_fingerprint: host.hostKey.fingerprint,
    backend_path: '/opt/ade/ade-control',
  })
  const unpaired = await profile.cli('remote', 'install', 'named', '--request-id', operationId('unpaired'))
  expect(unpaired.code).not.toBe(0)
  expect(unpaired.json?.message).toContain('named is not paired')
  await profile.call('remote.host.pair', { host_id: 'named', token_reference: { env: 'ADE_NAMED_TOKEN' } })

  const refused = await profile.cli('remote', 'install', 'named', '--request-id', operationId('named'))
  expect(refused.code).not.toBe(0)
  expect(refused.json).toMatchObject({ code: 'not_applied' })
  expect(refused.json?.message).toContain('does not replace a backend the user named')
  expect(await readdir(host.home)).not.toContain('.ade')
  expect((await remote.calls()).some((call) => call.remote_command?.includes('ade-installed'))).toBe(false)

  // A changed host key stops an install before anything is written.
  const other = await remote.host('rotated', { artifacts: [] })
  await addAndPair(profile, other, 'rotated')
  await other.changeHostKey()
  const rotated = await profile.call(
    'remote.host.install',
    { host_id: 'rotated', operation_id: operationId('rotated') },
    { timeoutMs: 500_000 },
  )
  expect(rotated.outcome).toBe('failed')
  expect(rotated.detail).toContain('did not present the pinned host key')
  expect(await readdir(other.home)).not.toContain('.ade')
})
