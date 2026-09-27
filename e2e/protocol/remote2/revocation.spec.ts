// F121 and F122: an authenticated endpoint on the execution host, explicit
// pairing, and revocation that the host itself enforces. A start grants the
// profile's pairing on the host by the SHA-256 of its token and returns the
// host's paired endpoint: an owner-only Unix socket reached only through the
// pinned SSH forward. Every connection there presents a pairing ID and token
// in hello. Revoking the pairing records it on the host, which refuses new
// connections, closes open ones and leaves the work it runs untouched.
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { expect, remoteCall, test } from '../fixtures/remote-hosts'
import { isRunning } from '../fixtures'
import { rawReply } from '../fixtures/services'
import { rpc } from '../../fixtures/daemon'
import {
  addAndPair, heldRemoteTurn, hostGrants, operationId, pairedLink, pairedTarget, remoteTurns, startRunning,
  startedHost,
} from './steps'

const execFileAsync = promisify(execFile)

async function tcpListeners(pid: number): Promise<string> {
  return execFileAsync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'])
    .then(({ stdout }) => stdout.trim(), () => '')
}

test('a start grants the pairing on an authenticated paired endpoint, and revocation there stops access while remote work keeps running', async ({ remote }) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const { daemon, pairing } = started

  // The endpoint is an owner-only Unix socket beside the owner socket; nothing listens on TCP.
  const paired = daemon.paired_socket!
  expect(paired).toBe(daemon.socket.replace(/\.sock$/, '.paired.sock'))
  const socket = await stat(paired)
  expect(socket.isSocket()).toBe(true)
  expect(socket.mode & 0o077).toBe(0)
  expect((await stat(dirname(paired))).isDirectory()).toBe(true)
  const runtimePid = (await started.host.daemonHello(started.remoteProfileId))?.runtime_pid as number
  for (const pid of [daemon.pid, runtimePid]) expect(await tcpListeners(pid)).toBe('')

  // The host holds the grant by digest only: the token is not on the host.
  expect(await hostGrants(started)).toEqual([expect.objectContaining({ pairing_id: pairing.pairing_id, state: 'active' })])
  const grantFile = await readFile(`${started.host.runtimeHome(started.remoteProfileId)}/access-grants.json`, 'utf8')
  expect(grantFile).not.toContain(remote.pairingToken)
  expect(grantFile).toContain(createHash('sha256').update(remote.pairingToken).digest('hex'))
  expect((await stat(`${started.host.runtimeHome(started.remoteProfileId)}/access-grants.json`)).mode & 0o077).toBe(0)

  // The endpoint admits nobody without a granted pairing: no credential, an unknown pairing, a wrong token.
  expect(await rawReply(paired, { op: 'hello' })).toMatchObject({ type: 'error', code: 'unauthenticated' })
  expect(await rawReply(paired, { op: 'catalog.get' })).toMatchObject({ type: 'error', code: 'unauthenticated' })
  expect(await rawReply(paired, { op: 'hello', pairing_id: 'not-a-pairing', pairing_token: remote.pairingToken }))
    .toMatchObject({ type: 'error', code: 'unauthenticated' })
  const wrong = await remote.transport(pairedTarget(started, 'not-the-token'))
  wrong.start()
  await expect(wrong.waitUntilConnected(15_000)).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(wrong.getState()).toMatchObject({ phase: 'failed', failure: 'unauthorized' })

  // The paired client reaches the started daemon, and only it, through the pinned forward.
  const link = await pairedLink(remote, started)
  const hello = await link.request('hello')
  expect(hello).toMatchObject({ pid: daemon.pid, boot_id: daemon.boot_id })
  const forward = (await remote.calls()).filter((call) => call.forwarding).at(-1)!
  expect(forward.forwarding![0].endsWith(`:${paired}`)).toBe(true)
  expect(forward.args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'HostKeyAlias=ade-remote-devbox',
    'StreamLocalBindMask=0177', '--', 'devbox']))

  // Remote work: a held turn, and the host's feed followed over the same pairing.
  const { conversation } = await heldRemoteTurn(link, started)
  const feed = link.openFeed()
  feed.start()
  await expect.poll(() => feed.getState().status).toBe('connected')
  expect(feed.getState().bootId).toBe(daemon.boot_id)

  const revoked = await profile.cli('remote', 'revoke', 'devbox', pairing.pairing_id)
  expect(revoked.code, revoked.stderr).toBe(0)
  expect(revoked.json).toMatchObject({ enforcement: 'remote_daemon', pairing: { pairing_id: pairing.pairing_id,
    state: 'revoked' } })
  expect(revoked.json?.detail).toBeUndefined()
  expect(await hostGrants(started)).toEqual([expect.objectContaining({ pairing_id: pairing.pairing_id,
    state: 'revoked' })])

  // The host refuses the revoked pairing: the open feed is closed and stays closed, the next
  // request is refused unsent, and a new connection with the same pairing is refused.
  await expect.poll(() => feed.getState().status).toBe('unavailable')
  expect(feed.getState().detail).toContain('revoked')
  await expect(remoteCall(link, 'conversation.get', { conversation_id: conversation.id }))
    .rejects.toMatchObject({ code: 'pairing_revoked', delivery: 'not_sent' })
  expect(link.getState()).toMatchObject({ phase: 'failed', failure: 'pairing_revoked' })
  await expect(remoteCall(link, 'agent.send', { conversation_id: conversation.id, request_id: 'after-revoke',
    text: 'hello' })).rejects.toMatchObject({ delivery: 'not_sent' })
  const again = await remote.transport(pairedTarget(started, remote.pairingToken))
  again.start()
  await expect(again.waitUntilConnected(15_000)).rejects.toMatchObject({ code: 'pairing_revoked' })
  expect(await rawReply(paired, { op: 'hello', pairing_id: pairing.pairing_id, pairing_token: remote.pairingToken }))
    .toMatchObject({ type: 'error', code: 'pairing_revoked' })
  // A CLI client presenting the revoked pairing is refused the same way.
  const cli = await profile.cli('remote', 'status', '--host', 'devbox', '--remote-profile', started.remoteProfileId,
    '--ssh', 'devbox', '--remote-socket', paired, '--host-key', started.registered.host_public_key,
    '--pairing', pairing.pairing_id, '--token-env', 'ADE_E2E_PAIRING_TOKEN', '--timeout-ms', '15000')
  expect(cli.code).not.toBe(0)
  expect(cli.json).toMatchObject({ code: 'pairing_revoked' })

  // Revoking again converges and is confirmed by the host again.
  const repeat = await profile.call('remote.host.revoke', { host_id: 'devbox', pairing_id: pairing.pairing_id },
    { timeoutMs: 75_000 })
  expect(repeat).toMatchObject({ enforcement: 'remote_daemon', pairing: { state: 'revoked' } })

  // The work on the host is untouched: same daemon, the turn still running, one turn started.
  expect(await isRunning(daemon.pid)).toBe(true)
  const owner = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
  expect((owner.conversation as { status: string }).status).toBe('running')
  expect(await remoteTurns(started)).toBe(1)

  // Pairing again is a new pairing. Its start attaches to the same daemon and grants only it;
  // the revoked pairing stays refused and the original turn is still the one running.
  const { pairing: renewed } = await addAndPair(profile, started.host, 'devbox',
    { remoteProfileId: started.remoteProfileId })
  expect(renewed.pairing_id).not.toBe(pairing.pairing_id)
  const reattached = await startRunning(profile, 'devbox')
  expect(reattached.daemon).toMatchObject({ pid: daemon.pid, boot_id: daemon.boot_id, paired_socket: paired })
  expect(await hostGrants(started)).toEqual([
    expect.objectContaining({ pairing_id: pairing.pairing_id, state: 'revoked' }),
    expect.objectContaining({ pairing_id: renewed.pairing_id, state: 'active' })])
  const renewedLink = await remote.transport(pairedTarget(started, remote.pairingToken, renewed))
  renewedLink.start()
  await renewedLink.waitUntilConnected(15_000)
  expect(await rawReply(paired, { op: 'hello', pairing_id: pairing.pairing_id, pairing_token: remote.pairingToken }))
    .toMatchObject({ type: 'error', code: 'pairing_revoked' })
  const after = await remoteCall(renewedLink, 'conversation.get', { conversation_id: conversation.id })
  expect(after.conversation.status).toBe('running')
  expect(await remoteTurns(started)).toBe(1)
  await remoteCall(renewedLink, 'agent.cancel', { conversation_id: conversation.id })
  await expect.poll(async () => (await remoteCall(renewedLink, 'conversation.get', { conversation_id: conversation.id }))
    .conversation.status, { timeout: 20_000 }).toBe('interrupted')
})

test('a revocation the host cannot receive is refused here, reported pending, and recorded on the host when revoked again', async ({ remote }) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const link = await pairedLink(remote, started)

  await started.host.linkDown()
  await expect.poll(() => link.getState().phase).not.toBe('connected')
  const pending = await profile.call('remote.host.revoke', { host_id: 'devbox', pairing_id: started.pairing.pairing_id },
    { timeoutMs: 75_000 })
  // The outcome on the host is not known, and the reply says so rather than claiming it.
  expect(pending).toMatchObject({ enforcement: 'local_profile', pairing: { state: 'revoked' } })
  expect(pending.detail).toContain('Revoke again when the host is reachable')
  // This profile already refuses the pairing: nothing is started or placed on the host.
  const refused = await profile.cli('remote', 'start', 'devbox', '--request-id', operationId('pending'))
  expect(refused.code).not.toBe(0)
  expect(refused.json?.message).toContain('was revoked')
  const check = await profile.call('placement.check', { host: { kind: 'remote', host_id: 'devbox' },
    resource: 'workspace' })
  expect(check).toMatchObject({ admitted: false, host: { kind: 'remote', host_id: 'devbox' } })
  // The host, read on the host itself, has not recorded it yet.
  expect(await hostGrants(started)).toEqual([expect.objectContaining({ state: 'active' })])

  // Revoking again once the link is back records it on the host, which then refuses the pairing.
  await started.host.linkUp()
  const confirmed = await profile.call('remote.host.revoke', { host_id: 'devbox',
    pairing_id: started.pairing.pairing_id }, { timeoutMs: 75_000 })
  expect(confirmed).toMatchObject({ enforcement: 'remote_daemon', pairing: { state: 'revoked' } })
  expect(await hostGrants(started)).toEqual([expect.objectContaining({ state: 'revoked' })])
  // The client's next hello, on a request or on its reconnect, is refused by the host, and it
  // stops for good.
  await expect.poll(async () => {
    await link.request('catalog.get').catch(() => null)
    return link.getState().failure
  }, { timeout: 60_000 }).toBe('pairing_revoked')
  expect(link.getState().phase).toBe('failed')
  await expect(link.request('catalog.get')).rejects.toMatchObject({ delivery: 'not_sent' })
  expect(await isRunning(started.daemon.pid)).toBe(true)
})

test('the host keeps its grants across a daemon crash and refuses a revoked pairing even when asked to grant it again', async ({ remote }) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const link = await pairedLink(remote, started)
  const first = link.getState().current!

  // A start with a new operation ID attaches and grants the same pairing again: one grant.
  const attached = await startRunning(profile, 'devbox')
  expect(attached.daemon).toMatchObject({ pid: started.daemon.pid, paired_socket: started.daemon.paired_socket })
  expect(await hostGrants(started)).toHaveLength(1)

  // The remote daemon crashes. Its restart reopens the paired endpoint from the host's grant
  // file, and the paired client reconnects to the same runtime.
  process.kill(started.daemon.pid, 'SIGKILL')
  await expect.poll(() => isRunning(started.daemon.pid)).toBe(false)
  await expect(link.request('catalog.get')).rejects.toMatchObject({ code: 'unavailable' })
  const restarted = await startRunning(profile, 'devbox')
  expect(restarted.daemon!.pid).not.toBe(started.daemon.pid)
  expect(restarted.daemon!.paired_socket).toBe(started.daemon.paired_socket)
  await expect.poll(() => link.getState().phase, { timeout: 30_000 }).toBe('connected')
  expect(link.getState().current?.runtimeSocket).toBe(first.runtimeSocket)
  expect(link.getState().current?.bootId).toBe(restarted.daemon!.boot_id)

  // Revocation also survives a crash of the host daemon.
  await profile.call('remote.host.revoke', { host_id: 'devbox', pairing_id: started.pairing.pairing_id },
    { timeoutMs: 75_000 })
  process.kill(restarted.daemon!.pid, 'SIGKILL')
  await expect.poll(() => isRunning(restarted.daemon!.pid)).toBe(false)
  const hostStart = await started.host.control('profiles', 'start', started.remoteProfileId)
  expect(hostStart.code, hostStart.stderr).toBe(0)
  expect(await rawReply(started.daemon.paired_socket!, { op: 'hello', pairing_id: started.pairing.pairing_id,
    pairing_token: remote.pairingToken })).toMatchObject({ type: 'error', code: 'pairing_revoked' })

  // A grant of the revoked pairing is refused on the host, even with its own token, and changes nothing.
  const digest = createHash('sha256').update(remote.pairingToken).digest('hex')
  const regrant = await started.host.control('profiles', 'start', started.remoteProfileId, '--grant',
    `${started.pairing.pairing_id}:${digest}`)
  expect(regrant.code).not.toBe(0)
  expect(regrant.stderr).toContain('Access grant refused')
  expect(await hostGrants(started)).toEqual([expect.objectContaining({ state: 'revoked' })])
})
