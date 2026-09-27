// Device claims across profiles (F099, F100; architecture section 5). Two
// profiles share one host registry and one fixture device host, the way
// managed profiles share a Mac. A simulator or emulator effect takes a
// host-wide exclusive claim; a run's hold keeps other profiles off the
// device; a crash mid-effect quarantines the claim until the owner's replay
// reconciles it.
import { expect, test, type ScratchProfile } from '../fixtures'
import { DeviceHost, samples } from '../fixtures/devices'
import { startHostProfiles } from '../fixtures/host-profiles'
import { boot, hostId, install, send } from './steps'

const iphone = `ios-sim:${samples.iphone}`
const ipad = `ios-sim:${samples.ipad}`

async function deviceClaims(profile: ScratchProfile) {
  return (await profile.call('resources.inspect', { resource: 'device' })).claims
}

async function sharedHost(ade: Parameters<typeof startHostProfiles>[0]) {
  const host = await DeviceHost.create(ade.root)
  const { profiles: [first, second] } = await startHostProfiles(ade, 2, { env: host.env() })
  return { host, first, second, id: await hostId(first) }
}

test('a run hold in one profile keeps another profile off the device until it is released', async ({ ade }) => {
  const { host, first, second, id } = await sharedHost(ade)
  const held = await first.call('resources.device.hold', { device_id: iphone, holder: 'run-a' })
  expect(held.registry.scope).toBe('host')
  const [claim] = held.claims.filter((entry) => entry.device_id === iphone)
  expect(claim).toMatchObject({ resource: 'device', holder: 'run-a', state: 'active', mine: true })

  // The other profile sees the hold and its boot is refused before any receipt.
  expect((await deviceClaims(second)).map((entry) => ({ id: entry.id, mine: entry.mine })))
    .toEqual([{ id: claim.id, mine: false }])
  const refused = await send(second, boot(id, iphone, 'boot-b'))
  expect(refused).toMatchObject({ type: 'error' })
  expect(refused.message).toContain(claim.id)
  expect(await host.calls('xcrun', 'bootstatus')).toEqual([])
  // A different device is free.
  expect(await send(second, boot(id, ipad, 'boot-ipad'))).toMatchObject({ type: 'device_booted', already_booted: true })

  // The holder's own profile may act on the device during its hold.
  expect(await send(first, boot(id, iphone, 'boot-a'))).toMatchObject({ type: 'device_booted', already_booted: false })

  // Released: the other profile's same operation ID is admitted.
  await first.call('resources.device.release', { device_id: iphone, holder: 'run-a' })
  expect(await deviceClaims(second)).toEqual([])
  expect(await send(second, boot(id, iphone, 'boot-b'))).toMatchObject({ type: 'device_booted', already_booted: true })
  expect(await host.calls('xcrun', 'bootstatus')).toHaveLength(1)
})

test('an effect in flight in one profile refuses the same device to another profile', async ({ ade }) => {
  const { host, first, second, id } = await sharedHost(ade)
  await host.hold('bootstatus')
  const running = send(first, boot(id, iphone, 'boot-a'))
  await host.held('bootstatus')

  const claims = await deviceClaims(second)
  expect(claims).toHaveLength(1)
  expect(claims[0]).toMatchObject({ device_id: iphone, operation_id: 'boot-a', mode: 'exclusive', mine: false,
    state: 'active' })
  const refused = await send(second, boot(id, iphone, 'boot-b'))
  expect(refused.message).toContain(claims[0].id)
  const app = await host.app('Demo', 'com.example.demo', '1')
  expect((await send(second, install(id, iphone, 'install-b', app))).message).toContain(claims[0].id)

  await host.release('bootstatus')
  expect(await running).toMatchObject({ type: 'device_booted', already_booted: false })
  await expect.poll(async () => (await deviceClaims(second)).length).toBe(0)
  expect(await send(second, install(id, iphone, 'install-b', app))).toMatchObject({ type: 'device_app_installed' })
})

test('a crash mid-effect quarantines the device claim until the owner replays the operation', async ({ ade }) => {
  const { host, first, second, id } = await sharedHost(ade)
  await host.hold('bootstatus', 'after')
  const lost = send(first, boot(id, iphone, 'boot-crash')).catch((error: Error) => error)
  await host.held('bootstatus')
  await first.killDaemon()
  expect(await lost).toBeInstanceOf(Error)

  // The owner is gone and the outcome is uncertain: the claim still refuses.
  await expect.poll(async () => (await deviceClaims(second)).map((entry) => entry.state)).toEqual(['quarantined'])
  const [quarantined] = await deviceClaims(second)
  expect(quarantined).toMatchObject({ device_id: iphone, operation_id: 'boot-crash', owner_live: false })
  expect((await send(second, boot(id, iphone, 'boot-b'))).message).toContain(quarantined.id)

  // The owner comes back and replays the same ID: reconciliation observes the
  // simulator booted, settles the receipt and releases the claim.
  await first.restartDaemon()
  expect(await send(first, boot(id, iphone, 'boot-crash'))).toMatchObject({ type: 'device_booted', already_booted: false })
  await expect.poll(async () => (await deviceClaims(second)).length).toBe(0)
  expect(await send(second, boot(id, iphone, 'boot-b'))).toMatchObject({ type: 'device_booted', already_booted: true })
  expect((await host.calls('xcrun', 'bootstatus')).filter((call) => !call.abandoned)).toHaveLength(1)
})
