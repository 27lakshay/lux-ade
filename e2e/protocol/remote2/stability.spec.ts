// R017 and 11-S08: a remote target stays the target through connection
// failure. The host is disconnected and later revoked while the user moves
// local focus to a local workspace and conversation. Commands for the remote
// work fail unsent or reconcile against the original remote daemon and
// runtime; nothing is placed, sent or run on this Mac, its providers or its
// devices instead.
import { expect, remoteCall, remoteClient, test } from '../fixtures/remote-hosts'
import { isRunning, startConversation } from '../fixtures'
import { rpc } from '../../fixtures/daemon'
import { heldRemoteTurn, hostEntry, pairedLink, remoteTurns, startedHost } from './steps'

const alphaHost = { kind: 'remote' as const, host_id: 'alpha' }

test('a disconnected and then revoked host keeps its work and identity while local focus moves; nothing falls back to this Mac', async ({ remote, repo }) => {
  const profile = await remote.profile()
  const alpha = await startedHost(remote, profile, 'alpha')
  const link = await pairedLink(remote, alpha)
  const pinned = link.getState().pinned
  const { workspace, conversation } = await heldRemoteTurn(link, alpha)
  await profile.call('placement.record', { host: alphaHost, resource: { kind: 'workspace', workspace_id: workspace.id } })
  await profile.call('placement.record', { host: alphaHost,
    resource: { kind: 'conversation', workspace_id: workspace.id, conversation_id: conversation.id } })
  const { admitPlacement, deviceCapability } = await remoteClient()
  const check = await profile.call('placement.check', { host: alphaHost, resource: 'conversation',
    workspace_id: workspace.id })
  expect(link.admitPlacement(check)).toMatchObject({ admitted: true, via: 'remote_transport', host: alphaHost })

  // The link drops.
  await alpha.host.linkDown()
  await expect.poll(() => link.getState().phase).not.toBe('connected')

  // Local focus moves: a local workspace and conversation become the ones in use.
  const local = await profile.call('workspace.open', { path: repo.path })
  const { conversationId: localConversation } = await startConversation(profile, 'codex', repo.path)

  // Commands for the remote work are refused unsent; none reaches this profile's daemon.
  await expect(remoteCall(link, 'agent.send', { conversation_id: conversation.id, request_id: 'while-down',
    text: 'hello' })).rejects.toMatchObject({ code: 'unavailable', delivery: 'not_sent' })
  expect(link.admitPlacement(check)).toMatchObject({ admitted: false, host: alphaHost })
  // The local daemon does not own the remote conversation and never runs it.
  await expect(profile.call('agent.send', { conversation_id: conversation.id, request_id: 'misrouted',
    text: 'hello' })).rejects.toThrow()
  // New work for the remote workspace is not placed here, whatever the focus.
  const localInRemote = await profile.call('placement.check', { host: { kind: 'local' }, resource: 'conversation',
    workspace_id: workspace.id })
  expect(localInRemote).toMatchObject({ admitted: false })
  expect(localInRemote.reason).toContain('remote host alpha')
  expect(admitPlacement(localInRemote, null, null)).toMatchObject({ admitted: false })
  // Placement records still name alpha; device control is not redirected to this Mac.
  expect((await profile.call('placement.resolve', { resource: { kind: 'conversation', workspace_id: workspace.id,
    conversation_id: conversation.id } })).placement.host).toEqual(alphaHost)
  expect(deviceCapability(await hostEntry(profile, 'alpha'))).toMatchObject({ access: 'unsupported',
    host: alphaHost })
  // This Mac's catalog holds only its own work, and its provider never saw the remote prompts.
  const catalog = (await profile.call('catalog.get', {})).catalog
  expect(catalog.conversations.map((entry) => entry.id)).toEqual([localConversation])
  expect(catalog.workspaces.map((entry) => entry.id)).toContain(local.workspace.id)
  expect(JSON.stringify(catalog)).not.toContain(workspace.id)
  expect(JSON.stringify(await profile.mockCalls('codex'))).not.toContain('while-down')
  expect(JSON.stringify(await profile.mockCalls('codex'))).not.toContain('misrouted')
  expect(await isRunning(alpha.daemon.pid)).toBe(true)

  // The link returns. The client reconciles against the same daemon and runtime: the
  // original turn is the one running, and retrying its send starts no second turn.
  await alpha.host.linkUp()
  await expect.poll(() => link.getState().phase, { timeout: 30_000 }).toBe('connected')
  expect(link.getState().pinned).toEqual(pinned)
  expect(link.getState().current?.bootId).toBe(alpha.daemon.boot_id)
  expect((await remoteCall(link, 'conversation.get', { conversation_id: conversation.id })).conversation.status)
    .toBe('running')
  // A client that lost the reply retries with the same request ID; the daemon either replays
  // or refuses it, and in both cases the one prompt is the only one and one turn runs.
  await remoteCall(link, 'agent.send', { conversation_id: conversation.id, request_id: 'held-turn', text: 'hold' })
    .catch(() => null)
  const reconciled = await remoteCall(link, 'conversation.get', { conversation_id: conversation.id })
  expect(reconciled.messages.filter((message) => message.id === 'held-turn')).toHaveLength(1)
  expect(reconciled.conversation.status).toBe('running')
  expect(await remoteTurns(alpha)).toBe(1)

  // The host is revoked while the focus stays local. Commands fail against alpha's identity,
  // placement is refused for alpha and for this Mac alike, and the remote turn keeps running.
  const revoked = await profile.call('remote.host.revoke', { host_id: 'alpha', pairing_id: alpha.pairing.pairing_id },
    { timeoutMs: 75_000 })
  expect(revoked.enforcement).toBe('remote_daemon')
  await expect(remoteCall(link, 'conversation.get', { conversation_id: conversation.id }))
    .rejects.toMatchObject({ code: 'pairing_revoked', delivery: 'not_sent' })
  expect(link.getState()).toMatchObject({ phase: 'failed', failure: 'pairing_revoked', pinned })
  const remoteCheck = await profile.call('placement.check', { host: alphaHost, resource: 'conversation',
    workspace_id: workspace.id })
  expect(remoteCheck).toMatchObject({ admitted: false, host: alphaHost })
  expect(link.admitPlacement(remoteCheck)).toMatchObject({ admitted: false, host: alphaHost })
  expect((await profile.call('placement.check', { host: { kind: 'local' }, resource: 'terminal',
    workspace_id: workspace.id })).admitted).toBe(false)
  expect((await profile.call('placement.resolve', { resource: { kind: 'workspace', workspace_id: workspace.id } }))
    .placement.host).toEqual(alphaHost)
  expect((await profile.call('catalog.get', {})).catalog.conversations.map((entry) => entry.id))
    .toEqual([localConversation])
  const owner = await rpc(alpha.daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
  expect((owner.conversation as { status: string }).status).toBe('running')
  expect(await remoteTurns(alpha)).toBe(1)
  await rpc(alpha.daemon.socket, { op: 'agent.cancel', conversation_id: conversation.id })
})
