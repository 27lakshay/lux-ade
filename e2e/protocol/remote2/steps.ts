// Steps the remote2 specs share, on top of ../remote/steps.ts: the paired
// endpoint target a started host granted, the host's own record of its
// grants, and a held Codex turn on a remote daemon.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, remoteCall, type RemoteLab, type RemoteTarget } from '../fixtures/remote-hosts'
import { repositoryRoot } from '../fixtures/environment'
import type { ScratchProfile } from '../fixtures'
import { startedHost } from '../remote/steps'

export { addAndPair, operationId, startRunning, startedHost, targetOf } from '../remote/steps'

type Started = Awaited<ReturnType<typeof startedHost>>
type Transport = Awaited<ReturnType<RemoteLab['transport']>>

/**
 * The SDK target for a started host's paired endpoint, presenting its pairing
 * with `token`. The endpoint is the one `remote.host.start` reported.
 */
export function pairedTarget(started: Started, token: string,
  pairing: { pairing_id: string } = started.pairing): RemoteTarget {
  const socket = started.daemon.paired_socket
  expect(socket, 'remote.host.start reports the paired endpoint it granted').toBeTruthy()
  return { hostId: started.hostId, profileId: started.remoteProfileId, destination: started.registered.ssh_target,
    remoteSocket: socket!, hostPublicKey: started.registered.host_public_key,
    pairing: { pairingId: pairing.pairing_id, token } }
}

/** A connected transport to the host's paired endpoint with the lab's pairing token. */
export async function pairedLink(remote: RemoteLab, started: Started): Promise<Transport> {
  const link = await remote.transport(pairedTarget(started, remote.pairingToken))
  link.start()
  await link.waitUntilConnected(15_000)
  return link
}

/** The host's grant list for its remote profile, read on the host with its own ade-control. */
export async function hostGrants(started: Started): Promise<Array<{ pairing_id: string; state: string }>> {
  const listed = await started.host.control('profiles', 'access-list', started.remoteProfileId)
  expect(listed.code, listed.stderr).toBe(0)
  return listed.json?.grants as Array<{ pairing_id: string; state: string }>
}

/** Opens a workspace on the host and starts a Codex turn the host's mock holds until cancelled. */
export async function heldRemoteTurn(link: Transport, started: Started, requestId = 'held-turn') {
  const { workspace } = await remoteCall(link, 'workspace.open', { path: (await started.host.repo('app')).path })
  const { conversation } = await remoteCall(link, 'conversation.create', { workspace_id: workspace.id,
    provider: 'codex' })
  await remoteCall(link, 'agent.send', { conversation_id: conversation.id, request_id: requestId, text: 'hold' })
  await expect.poll(async () => (await remoteCall(link, 'conversation.get', { conversation_id: conversation.id }))
    .conversation.status, { timeout: 20_000 }).toBe('running')
  return { workspace, conversation }
}

/** How many turns the host's own Codex mock started. */
export async function remoteTurns(started: Started): Promise<number> {
  return (await started.host.mockCalls('codex')).filter((call) => call.method === 'turn/start').length
}

/** The placement.hosts entry for `hostId` as this profile reports it now. */
export async function hostEntry(profile: ScratchProfile, hostId: string) {
  const { hosts } = await profile.call('placement.hosts', {})
  const entry = hosts.find((candidate) => candidate.host.kind === 'remote' && candidate.host.host_id === hostId)
  expect(entry, `placement.hosts lists ${hostId}`).toBeTruthy()
  return entry!
}

type SyncModule = typeof import('../../../packages/client/dist/sync.js')
/** The SDK's transport-free feed reducer (`@ade/client/sync`). */
export function clientSync(): Promise<SyncModule> {
  return import(pathToFileURL(join(repositoryRoot, 'packages/client/dist/sync.js')).href) as Promise<SyncModule>
}
