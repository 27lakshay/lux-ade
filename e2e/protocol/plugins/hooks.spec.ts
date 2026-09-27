// Lifecycle hooks (F058): a committed event reaches the plugin's backend host
// through the durable outbox with a stable effect ID. Lost outcomes become
// unknown and are never sent again without an acknowledged retry.
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, prompts, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { installAndEnable, pluginLines, stagePlugin } from '../fixtures/plugins'

/** Open a new workspace folder named `name`; its creation commits a workspace.created event. */
async function newWorkspace(profile: ScratchProfile, root: string, name: string): Promise<string> {
  const path = join(root, 'hook-workspaces', name)
  await mkdir(path, { recursive: true })
  const { workspace } = await profile.call('workspace.open', { path: await realpath(path) })
  return workspace.root
}

async function deliveryFor(profile: ScratchProfile, pluginId: string, root: string) {
  const { deliveries } = await profile.call('hook.delivery.list', { plugin_id: pluginId })
  return deliveries.find((delivery) => (delivery.payload as { root?: string }).root === root)
}

async function waitForDelivery(
  profile: ScratchProfile,
  pluginId: string,
  root: string,
  status: string,
  timeout = 20_000,
) {
  await expect.poll(async () => (await deliveryFor(profile, pluginId, root))?.status, { timeout }).toBe(status)
  const delivery = await deliveryFor(profile, pluginId, root)
  if (!delivery) throw new Error(`No delivery for ${root}`)
  return delivery
}

async function sends(outDir: string, effectId: string) {
  return (await pluginLines(outDir, 'hooks.jsonl')).filter((line) => line.effect_id === effectId)
}

test('delivers a committed workspace.created hook once with a stable effect ID, and only while subscribed', async ({
  ade,
  profile,
}) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  expect((await profile.call('hook.subscription.list', {})).subscriptions).toEqual(
    expect.arrayContaining([
      { plugin_id: pluginId, event: 'workspace.created', activation_generation: 1 },
      { plugin_id: pluginId, event: 'turn.settled', activation_generation: 1 },
    ]),
  )

  const root = await newWorkspace(profile, ade.root, 'ok')
  const delivered = await waitForDelivery(profile, pluginId, root, 'delivered')
  expect(delivered).toMatchObject({ event: 'workspace.created', attempts: 1, activation_generation: 1, error: null })
  expect(delivered.effect_id).toMatch(/^hookfx_/)
  // The event had committed: the workspace it names is in the catalog.
  const catalog = await profile.call('catalog.get', {})
  expect(catalog.catalog.workspaces.map((workspace) => workspace.id)).toContain(
    (delivered.payload as { workspace_id: string }).workspace_id,
  )
  expect(await sends(outDir, delivered.effect_id)).toEqual([
    expect.objectContaining({ attempt: 1, event: 'workspace.created', root }),
  ])
  expect((await profile.call('hook.delivery.list', { status: 'delivered' })).host).toMatchObject({ available: true })

  // Reopening the same folder is not a new workspace; a delivered hook cannot be retried.
  await profile.call('workspace.open', { path: root })
  expect((await profile.call('hook.delivery.list', { plugin_id: pluginId })).deliveries).toHaveLength(1)
  await expect(
    profile.call('hook.delivery.retry', { operation_id: 'retry-delivered', effect_id: delivered.effect_id }),
  ).rejects.toThrow()

  // Without an activation there is no subscription, so the commit enqueues nothing.
  await profile.call('plugin.disable', { plugin_id: pluginId })
  expect((await profile.call('hook.subscription.list', {})).subscriptions).toEqual([])
  const unsubscribed = await newWorkspace(profile, ade.root, 'unsubscribed')
  expect(await deliveryFor(profile, pluginId, unsubscribed)).toBeUndefined()
})

test('a failed hook is sent again only on an explicit retry, with the same effect ID', async ({ ade, profile }) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const root = await newWorkspace(profile, ade.root, 'fail-hook')
  const failed = await waitForDelivery(profile, pluginId, root, 'failed')
  expect(failed.error).toContain('fixture hook failed')
  expect(await sends(outDir, failed.effect_id)).toHaveLength(1)

  const retried = await profile.call('hook.delivery.retry', {
    operation_id: 'retry-failed',
    effect_id: failed.effect_id,
  })
  expect(retried.delivery.status).toBe('queued')
  const again = await waitForDelivery(profile, pluginId, root, 'failed')
  expect(again.attempts).toBe(2)
  expect((await sends(outDir, failed.effect_id)).map((line) => line.attempt)).toEqual([1, 2])

  // A repeat of the same retry returns its first answer and queues nothing.
  expect(
    await profile.call('hook.delivery.retry', { operation_id: 'retry-failed', effect_id: failed.effect_id }),
  ).toEqual(retried)
  const later = await newWorkspace(profile, ade.root, 'after-retry')
  await waitForDelivery(profile, pluginId, later, 'delivered')
  expect(await sends(outDir, failed.effect_id)).toHaveLength(2)

  const abandoned = await profile.call('hook.delivery.abandon', { effect_id: failed.effect_id })
  expect(abandoned.delivery.status).toBe('abandoned')
  await expect(
    profile.call('hook.delivery.retry', { operation_id: 'retry-abandoned', effect_id: failed.effect_id }),
  ).rejects.toThrow()
})

test('a hook whose host crashed mid-delivery becomes unknown and is resent only with acknowledgement', async ({
  ade,
  profile,
}) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const root = await newWorkspace(profile, ade.root, 'crash-hook')
  const unknown = await waitForDelivery(profile, pluginId, root, 'unknown')
  expect(unknown.attempts).toBe(1)
  expect(await sends(outDir, unknown.effect_id)).toHaveLength(1)

  // Later deliveries go through once the host is back; the unknown one is not sent again on its own.
  const later = await newWorkspace(profile, ade.root, 'after-crash')
  await waitForDelivery(profile, pluginId, later, 'delivered')
  expect(await sends(outDir, unknown.effect_id)).toHaveLength(1)
  expect((await profile.call('hook.delivery.inspect', { effect_id: unknown.effect_id })).delivery.status).toBe(
    'unknown',
  )

  await expect(
    profile.call('hook.delivery.retry', { operation_id: 'retry-unacknowledged', effect_id: unknown.effect_id }),
  ).rejects.toThrow(/acknowledge/i)
  await profile.call('hook.delivery.retry', {
    operation_id: 'retry-acknowledged',
    effect_id: unknown.effect_id,
    acknowledge_unknown: true,
  })
  await expect
    .poll(async () => (await sends(outDir, unknown.effect_id)).map((line) => line.attempt), { timeout: 20_000 })
    .toEqual([1, 2])
  await waitForDelivery(profile, pluginId, root, 'unknown')
})

test('a delivery in flight when the daemon dies becomes unknown after restart and is never replayed', async ({
  ade,
  profile,
}) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const root = await newWorkspace(profile, ade.root, 'hold-hook')
  const inFlight = await waitForDelivery(profile, pluginId, root, 'dispatching')
  // The handler has started and holds until released; the daemon dies meanwhile.
  await expect.poll(async () => (await sends(outDir, inFlight.effect_id)).length).toBe(1)
  await profile.killDaemon()
  await profile.restartDaemon()

  const lost = await deliveryFor(profile, pluginId, root)
  expect(lost).toMatchObject({ effect_id: inFlight.effect_id, status: 'unknown', attempts: 1 })
  expect(lost?.error).toMatch(/may or may not have applied/)

  const later = await newWorkspace(profile, ade.root, 'after-restart')
  const delivered = await waitForDelivery(profile, pluginId, later, 'delivered')
  expect(delivered.activation_generation).toBeGreaterThan(inFlight.activation_generation)
  expect(await sends(outDir, inFlight.effect_id)).toHaveLength(1)
})

test('a settled Conversation turn reaches the plugin as turn.settled after it commits', async ({ ade, profile }) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const { conversationId } = await startConversation(profile, 'codex')
  await send(profile, conversationId, prompts.turn)
  await waitForIdle(profile, conversationId)
  await expect
    .poll(
      async () =>
        (await profile.call('hook.delivery.list', { plugin_id: pluginId })).deliveries
          .filter((delivery) => delivery.event === 'turn.settled')
          .map((delivery) => delivery.status),
      { timeout: 20_000 },
    )
    .toEqual(['delivered'])
  const [settled] = (await profile.call('hook.delivery.list', { plugin_id: pluginId })).deliveries.filter(
    (delivery) => delivery.event === 'turn.settled',
  )
  expect(settled.payload).toMatchObject({ conversation_id: conversationId, outcome: 'completed', provider: 'codex' })
  expect(await sends(outDir, settled.effect_id)).toEqual([
    expect.objectContaining({ conversation_id: conversationId, outcome: 'completed', attempt: 1 }),
  ])
})
