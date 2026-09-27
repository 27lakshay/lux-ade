// F126: several execution hosts at once. Each host has its own pairing,
// transport and feed. A feed carries its own daemon's boot ID and revision,
// so one host's cursor is never applied to another host's projection. Each
// host's provider account is its own; a link loss, a revocation or a daemon
// restart on one host leaves the other host's connection and cursor alone.
import { expect, remoteCall, remoteClient, test } from '../fixtures/remote-hosts'
import type { FeedFrame } from '../../../packages/client/dist/index.js'
import { clientSync, heldRemoteTurn, hostGrants, pairedLink, remoteTurns, startRunning, startedHost } from './steps'

type Feed = ReturnType<Awaited<ReturnType<typeof pairedLink>>['openFeed']>

/** Collects every feed frame a client receives after this call. */
function record(feed: Feed): FeedFrame[] {
  const frames: FeedFrame[] = []
  feed.subscribeFeed((frame) => frames.push(frame))
  return frames
}

function conversationFrames(frames: FeedFrame[], conversationId: string): FeedFrame[] {
  return frames.filter((frame) => frame.type === 'conversation_changed' &&
    (frame.conversation as { id?: string } | undefined)?.id === conversationId)
}

test('two hosts at once keep their own feeds, cursors and provider accounts, and fail over nothing', async ({ remote }) => {
  const profile = await remote.profile()
  const alpha = await startedHost(remote, profile, 'alpha')
  const beta = await startedHost(remote, profile, 'beta')
  expect(alpha.pairing.pairing_id).not.toBe(beta.pairing.pairing_id)
  expect(alpha.daemon.paired_socket).not.toBe(beta.daemon.paired_socket)

  const alphaLink = await pairedLink(remote, alpha)
  const betaLink = await pairedLink(remote, beta)
  const alphaFeed = alphaLink.openFeed()
  const betaFeed = betaLink.openFeed()
  const alphaFrames = record(alphaFeed)
  const betaFrames = record(betaFeed)
  alphaFeed.start()
  betaFeed.start()
  await expect.poll(() => [alphaFeed.getState().status, betaFeed.getState().status]).toEqual(['connected', 'connected'])
  // Each feed's cursor epoch is its own daemon's boot.
  expect(alphaFeed.getState().bootId).toBe(alpha.daemon.boot_id)
  expect(betaFeed.getState().bootId).toBe(beta.daemon.boot_id)

  // A turn on alpha runs with alpha's provider and reaches alpha's feed only.
  const alphaTurn = await heldRemoteTurn(alphaLink, alpha, 'alpha-turn')
  await expect.poll(() => conversationFrames(alphaFrames, alphaTurn.conversation.id).length).toBeGreaterThan(0)
  expect(alphaFrames.every((frame) => frame.boot_id === alpha.daemon.boot_id)).toBe(true)
  expect(JSON.stringify(betaFrames)).not.toContain(alphaTurn.conversation.id)
  expect(await remoteTurns(alpha)).toBe(1)
  expect(await remoteTurns(beta)).toBe(0)
  expect(await profile.mockCalls('codex')).toEqual([])
  expect(betaFeed.getState().catalog?.conversations.map((entry) => entry.id)).not.toContain(alphaTurn.conversation.id)

  // A frame from one host cannot advance another host's projection: its boot differs.
  const { reduceFrame } = await clientSync()
  const alphaSnapshot = { ...(await remoteCall(alphaLink, 'conversation.get', { conversation_id: alphaTurn.conversation.id })),
    boot_id: alphaFeed.getState().bootId!, revision: alphaFeed.getState().revision! }
  const foreign = betaFrames.at(-1) ?? { type: 'catalog', boot_id: betaFeed.getState().bootId!, revision:
    betaFeed.getState().revision! }
  expect(reduceFrame(alphaSnapshot as never, foreign as never, alphaTurn.conversation.id))
    .toEqual({ kind: 'resnapshot', reason: 'boot' })

  // Alpha loses its link. Beta keeps its connection and cursor and keeps receiving its own work.
  const betaRevision = betaFeed.getState().revision!
  await alpha.host.linkDown()
  await expect.poll(() => alphaFeed.getState().status).not.toBe('connected')
  const { remoteStatus } = await remoteClient()
  await expect.poll(() => remoteStatus(alphaLink.getState())).toBe('unknown')
  expect(betaLink.getState().phase).toBe('connected')
  expect(betaFeed.getState().status).toBe('connected')
  const betaTurn = await heldRemoteTurn(betaLink, beta, 'beta-turn')
  await expect.poll(() => conversationFrames(betaFrames, betaTurn.conversation.id).length).toBeGreaterThan(0)
  expect(betaFeed.getState().revision!).toBeGreaterThan(betaRevision)
  expect(betaFrames.every((frame) => frame.boot_id === beta.daemon.boot_id)).toBe(true)
  expect(await remoteTurns(beta)).toBe(1)
  expect(await remoteTurns(alpha)).toBe(1)
  // Nothing of alpha's was sent to beta or to this profile while alpha was down.
  await expect(remoteCall(alphaLink, 'conversation.get', { conversation_id: alphaTurn.conversation.id }))
    .rejects.toMatchObject({ delivery: 'not_sent' })
  expect(JSON.stringify(betaFrames)).not.toContain(alphaTurn.conversation.id)
  expect(await profile.mockCalls('codex')).toEqual([])

  // Alpha reconnects to its own runtime; its feed resumes on alpha's boot, never beta's.
  await alpha.host.linkUp()
  await expect.poll(() => alphaLink.getState().phase, { timeout: 30_000 }).toBe('connected')
  await expect.poll(() => alphaFeed.getState().status, { timeout: 30_000 }).toBe('connected')
  expect(alphaFeed.getState().bootId).toBe(alpha.daemon.boot_id)
  expect(alphaFeed.getState().catalog?.conversations.map((entry) => entry.id)).toContain(alphaTurn.conversation.id)
  expect(alphaFeed.getState().catalog?.conversations.map((entry) => entry.id)).not.toContain(betaTurn.conversation.id)
  expect(alphaFrames.every((frame) => frame.boot_id === alpha.daemon.boot_id)).toBe(true)
  expect((await remoteCall(alphaLink, 'conversation.get', { conversation_id: alphaTurn.conversation.id }))
    .conversation.status).toBe('running')

  // Alpha's daemon restarts: alpha's cursor moves to a new boot; beta's stays where it was.
  const betaBoot = betaFeed.getState().bootId
  process.kill(alpha.daemon.pid, 'SIGKILL')
  const restarted = await startRunning(profile, 'alpha')
  await expect.poll(() => alphaFeed.getState().bootId, { timeout: 30_000 }).toBe(restarted.daemon!.boot_id)
  expect(betaFeed.getState().bootId).toBe(betaBoot)
  expect(betaFeed.getState().status).toBe('connected')

  // Revoking alpha's pairing ends alpha's feed; beta's pairing, feed and grant are untouched.
  const revoked = await profile.call('remote.host.revoke', { host_id: 'alpha', pairing_id: alpha.pairing.pairing_id },
    { timeoutMs: 75_000 })
  expect(revoked.enforcement).toBe('remote_daemon')
  await expect.poll(() => alphaFeed.getState().status).toBe('unavailable')
  expect(await hostGrants(beta)).toEqual([expect.objectContaining({ pairing_id: beta.pairing.pairing_id,
    state: 'active' })])
  expect(betaFeed.getState().status).toBe('connected')
  expect((await remoteCall(betaLink, 'catalog.get', {})).boot_id).toBe(beta.daemon.boot_id)
  const hosts = (await profile.call('remote.host.list', {})).hosts
  expect(hosts.map((host) => [host.host_id, host.pairing?.state])).toEqual([['alpha', 'revoked'], ['beta', 'active']])

  for (const [link, turn] of [[betaLink, betaTurn]] as const) {
    await remoteCall(link, 'agent.cancel', { conversation_id: turn.conversation.id })
  }
})
