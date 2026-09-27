// iOS simulator effects (F099; decision D12; architecture section 4). Boot,
// install and launch are effect commands: each carries an operation ID, keeps
// a receipt in the profile database, replays its stored outcome, refuses the
// same ID with other parameters, and after a daemon crash reconciles by
// observing the simulator rather than running the tool again. The simulator
// is a PATH shim for `xcrun simctl` returning recorded output.
import { expect, test } from '../fixtures'
import { samples } from '../fixtures/devices'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { boot, device, deviceProfile, hostId, install, inventory, launch, resolveQuarantine, send } from './steps'

const iphone = `ios-sim:${samples.iphone}`

test('boot, install, launch and capture one simulator; replays return the receipt without rerunning simctl', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const app = await host.app('Demo', 'com.example.demo', '42')

  const booted = await profile.call('device.boot', { operation_id: 'boot-1', host_id: id, device_id: iphone })
  expect(booted).toMatchObject({
    type: 'device_booted',
    operation_id: 'boot-1',
    host_id: id,
    device_id: iphone,
    already_booted: false,
    serial: null,
  })
  expect(device(await inventory(profile, 'ios_simulator'), iphone).state).toBe('booted')

  const installed = await profile.call('device.app.install', {
    operation_id: 'install-1',
    host_id: id,
    device_id: iphone,
    app_path: app,
  })
  expect(installed).toMatchObject({ type: 'device_app_installed', app_id: 'com.example.demo', version: '42' })

  const launched = await profile.call('device.app.launch', {
    operation_id: 'launch-1',
    host_id: id,
    device_id: iphone,
    app_id: 'com.example.demo',
  })
  expect(launched).toMatchObject({ type: 'device_app_launched', app_id: 'com.example.demo' })
  expect(launched.pid).toBe((await host.calls('xcrun', 'launch'))[0].launched_pid)

  const shot = await profile.call('device.screenshot', { host_id: id, device_id: iphone })
  expect(shot).toMatchObject({ type: 'device_screenshot', mime: 'image/png', width: 1206, height: 2622 })
  expect(Buffer.from(shot.bytes_base64, 'base64').length).toBe(shot.bytes)

  // Replays: the stored outcome, with no second tool run.
  expect(await profile.call('device.boot', { operation_id: 'boot-1', host_id: id, device_id: iphone })).toEqual(booted)
  expect(
    await profile.call('device.app.install', {
      operation_id: 'install-1',
      host_id: id,
      device_id: iphone,
      app_path: app,
    }),
  ).toEqual(installed)
  expect(
    await profile.call('device.app.launch', {
      operation_id: 'launch-1',
      host_id: id,
      device_id: iphone,
      app_id: 'com.example.demo',
    }),
  ).toEqual(launched)
  // The CLI replays the same receipts.
  const cliLaunch = await profile.cli('device', 'launch', id, iphone, 'com.example.demo', '--request-id', 'launch-1')
  expect(cliLaunch.code).toBe(0)
  expect(cliLaunch.json).toMatchObject({ operation_id: 'launch-1', pid: launched.pid })
  expect(await host.calls('xcrun', 'bootstatus')).toHaveLength(1)
  expect(await host.calls('xcrun', 'install')).toHaveLength(1)
  expect(await host.calls('xcrun', 'launch')).toHaveLength(1)

  // The same ID with other parameters is a conflict, not a replay.
  const conflict = await send(profile, launch(id, iphone, 'launch-1', 'com.example.other'))
  expect(conflict).toMatchObject({ type: 'error' })
  expect(conflict.message).toContain('already used for different parameters')

  // A new ID launches again; booting a booted simulator records that it already was.
  const again = await profile.call('device.app.launch', {
    operation_id: 'launch-2',
    host_id: id,
    device_id: iphone,
    app_id: 'com.example.demo',
  })
  expect(again.pid).not.toBe(launched.pid)
  const rebooted = await profile.cli('device', 'boot', id, iphone, '--request-id', 'boot-2')
  expect(rebooted.json).toMatchObject({ already_booted: true })
  expect(await host.calls('xcrun', 'bootstatus')).toHaveLength(1)

  // Receipts are durable: a restarted daemon replays them.
  await profile.restartDaemon('kill')
  expect(
    await profile.call('device.app.install', {
      operation_id: 'install-1',
      host_id: id,
      device_id: iphone,
      app_path: app,
    }),
  ).toEqual(installed)
  expect(await host.calls('xcrun', 'install')).toHaveLength(1)

  // The CLI saves a capture and refuses to replace an existing file.
  const out = `${ade.root}/shot.png`
  const saved = await profile.cli('device', 'screenshot', id, iphone, '--out', out)
  expect(saved.code).toBe(0)
  expect(saved.json).toMatchObject({ path: out, width: 1206, height: 2622 })
  expect((await profile.cli('device', 'screenshot', id, iphone, '--out', out)).code).not.toBe(0)
})

test('a duplicate request while the effect runs is refused, and another operation on the device waits its turn', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  await host.hold('bootstatus')
  const first = send(profile, boot(id, iphone, 'boot-dup'))
  await host.held('bootstatus')

  const duplicate = await send(profile, boot(id, iphone, 'boot-dup'))
  expect(duplicate.message).toContain('Operation boot-dup is still running')
  const other = await send(profile, boot(id, iphone, 'boot-other'))
  expect(other.message).toContain(`Another device operation is running on ${iphone}`)
  // A different simulator is not blocked.
  const ipadShot = await send(profile, { op: 'device.screenshot', host_id: id, device_id: `ios-sim:${samples.ipad}` })
  expect(ipadShot.type).toBe('device_screenshot')

  await host.release('bootstatus')
  expect(await first).toMatchObject({ type: 'device_booted', already_booted: false })
  // The refused ID was never admitted; it now runs and finds the device booted.
  expect(await send(profile, boot(id, iphone, 'boot-other'))).toMatchObject({
    type: 'device_booted',
    already_booted: true,
  })
  expect(await host.calls('xcrun', 'bootstatus')).toHaveLength(1)
})

test('a caller that lost the reply retries the same ID and gets the one install that ran', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const ipad = `ios-sim:${samples.ipad}`
  const app = await host.app('Demo', 'com.example.demo', '8')
  await sendAndLoseReply(profile, install(id, ipad, 'install-lost', app))
  let reply: Record<string, unknown> = {}
  await expect
    .poll(
      async () => {
        reply = await send(profile, install(id, ipad, 'install-lost', app))
        return reply.type === 'error' && String(reply.message).includes('is still running') ? 'running' : reply.type
      },
      { timeout: 20_000 },
    )
    .toBe('device_app_installed')
  expect(reply).toMatchObject({ operation_id: 'install-lost', app_id: 'com.example.demo', version: '8' })
  expect(await host.calls('xcrun', 'install')).toHaveLength(1)
})

test('a boot interrupted by a daemon crash is reconciled from the simulator and never retried', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)

  // Crash before simctl changed anything: the replay reports a failed boot.
  await host.hold('bootstatus', 'before')
  const lost = send(profile, boot(id, iphone, 'boot-crash')).catch((error: Error) => error)
  await host.held('bootstatus')
  await profile.restartDaemon('kill')
  expect(await lost).toBeInstanceOf(Error)
  await expect.poll(async () => (await host.calls('xcrun', 'bootstatus')).length).toBe(1)
  expect((await host.calls('xcrun', 'bootstatus'))[0].abandoned).toBe('bootstatus')
  expect(device(await inventory(profile, 'ios_simulator'), iphone).state).toBe('shutdown')

  const replay = await send(profile, boot(id, iphone, 'boot-crash'))
  expect(replay.message).toContain('was interrupted and the device is not booted; it was not retried')
  expect(await send(profile, boot(id, iphone, 'boot-crash'))).toMatchObject({ message: replay.message })
  expect(await host.calls('xcrun', 'bootstatus')).toHaveLength(1)
  expect(device(await inventory(profile, 'ios_simulator'), iphone).state).toBe('shutdown')

  // Crash after the simulator booted: the replay settles the boot as done.
  await host.hold('bootstatus', 'after')
  const lost2 = send(profile, boot(id, iphone, 'boot-crash-2')).catch((error: Error) => error)
  await host.held('bootstatus')
  await profile.restartDaemon('kill')
  expect(await lost2).toBeInstanceOf(Error)
  const settled = await send(profile, boot(id, iphone, 'boot-crash-2'))
  expect(settled).toMatchObject({ type: 'device_booted', operation_id: 'boot-crash-2', already_booted: false })
  // One boot ran, and only the abandoned-before-effect attempt precedes it.
  expect((await host.calls('xcrun', 'bootstatus')).map((call) => call.abandoned ?? 'booted')).toEqual([
    'bootstatus',
    'booted',
    'bootstatus',
  ])
})

test('an install interrupted by a crash settles by the version the simulator reports', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const ipad = `ios-sim:${samples.ipad}`
  const app = await host.app('Demo', 'com.example.demo', '7')

  // The install landed before the crash: the replay confirms it.
  await host.hold('install', 'after')
  const lost = send(profile, install(id, ipad, 'install-crash', app)).catch((error: Error) => error)
  await host.held('install')
  await profile.restartDaemon('kill')
  expect(await lost).toBeInstanceOf(Error)
  expect(await send(profile, install(id, ipad, 'install-crash', app))).toMatchObject({
    type: 'device_app_installed',
    app_id: 'com.example.demo',
    version: '7',
  })

  // It did not land: the replay reports that and does not install.
  const other = await host.app('Other', 'com.example.other', '1')
  await host.hold('install', 'before')
  const lost2 = send(profile, install(id, ipad, 'install-crash-2', other)).catch((error: Error) => error)
  await host.held('install')
  await profile.restartDaemon('kill')
  expect(await lost2).toBeInstanceOf(Error)
  const replay = await send(profile, install(id, ipad, 'install-crash-2', other))
  expect(replay.message).toContain(
    'The install of com.example.other 1 was interrupted and the device does not report it; it was not retried',
  )
  const installs = await host.calls('xcrun', 'install')
  expect(installs.filter((call) => !call.abandoned)).toHaveLength(1)
})

test('launch and install outcomes that cannot be observed become unknown and are never rerun', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const ipad = `ios-sim:${samples.ipad}`
  const app = await host.app('Demo', 'com.example.demo', '5')
  await profile.call('device.app.install', { operation_id: 'install-ok', host_id: id, device_id: ipad, app_path: app })

  // A launch interrupted by a crash: whether it ran is not observable.
  await host.hold('launch')
  const lost = send(profile, launch(id, ipad, 'launch-crash', 'com.example.demo')).catch((error: Error) => error)
  await host.held('launch')
  await profile.restartDaemon('kill')
  expect(await lost).toBeInstanceOf(Error)
  const unknown = await send(profile, launch(id, ipad, 'launch-crash', 'com.example.demo'))
  expect(unknown.message).toContain('Operation launch-crash outcome is unknown')
  expect(unknown.message).toContain(
    'It was not run again. Inspect the device, release its quarantined claim with resources.claim.resolve',
  )
  expect((await send(profile, launch(id, ipad, 'launch-crash', 'com.example.demo'))).message).toBe(unknown.message)
  expect((await host.calls('xcrun', 'launch')).filter((call) => !call.abandoned)).toHaveLength(0)

  // The uncertain outcome quarantines the simulator, for this profile too,
  // until the caller inspects it and resolves the claim.
  const blocked = await send(profile, launch(id, ipad, 'launch-no-pid', 'com.example.demo'))
  expect(blocked.message).toContain(`quarantined exclusive use claim on ${ipad} held by this profile`)
  await resolveQuarantine(profile, ipad, 'resolve-1')

  // simctl printed no process ID.
  await host.update((state) => {
    state.launch_without_pid = true
  })
  const noPid = await send(profile, launch(id, ipad, 'launch-no-pid', 'com.example.demo'))
  expect(noPid.message).toContain('outcome is unknown: simctl reported no process ID')
  expect((await send(profile, launch(id, ipad, 'launch-no-pid', 'com.example.demo'))).message).toBe(noPid.message)
  expect((await host.calls('xcrun', 'launch')).filter((call) => !call.abandoned)).toHaveLength(1)
  await resolveQuarantine(profile, ipad, 'resolve-2')

  // simctl installed, but the daemon cannot read what the simulator reports.
  await host.update((state) => {
    state.install_breaks_container = true
  })
  const second = await host.app('Second', 'com.example.second', '2')
  const unverifiable = await send(profile, install(id, ipad, 'install-unverifiable', second))
  expect(unverifiable.message).toContain('outcome is unknown: install could not be verified')
  expect((await send(profile, install(id, ipad, 'install-unverifiable', second))).message).toBe(unverifiable.message)
  await resolveQuarantine(profile, ipad, 'resolve-3')

  // simctl installed, but the simulator reports another version: a settled failure.
  await host.update((state) => {
    state.install_breaks_container = false
    state.install_reports_version = '1'
  })
  const third = await host.app('Third', 'com.example.third', '9')
  const mismatch = await send(profile, install(id, ipad, 'install-mismatch', third))
  expect(mismatch.message).toContain('the device reports com.example.third at 1 instead of 9')
  expect((await send(profile, install(id, ipad, 'install-mismatch', third))).message).toBe(mismatch.message)
  expect(await host.calls('xcrun', 'install')).toHaveLength(3)
})

test('a simulator deleted after listing is unavailable, and no other simulator is touched', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  expect(device(await inventory(profile, 'ios_simulator'), iphone).state).toBe('shutdown')
  await host.update((state) => {
    state.simulators = state.simulators.filter((sim) => sim.udid !== samples.iphone)
  })
  for (const request of [
    boot(id, iphone, 'gone-boot'),
    launch(id, iphone, 'gone-launch', 'com.example.demo'),
    { op: 'device.screenshot', host_id: id, device_id: iphone },
  ]) {
    const refused = await send(profile, request)
    expect(refused.message, String(request.op)).toContain(
      `Device ${iphone} is unavailable: it is not attached to this host now`,
    )
  }
  expect(await host.calls()).toEqual([])
  // A lowercase UDID names the same simulator, never another.
  const ipad = await send(profile, boot(id, `ios-sim:${samples.ipad.toLowerCase()}`, 'case-boot'))
  expect(ipad).toMatchObject({ type: 'device_booted', device_id: `ios-sim:${samples.ipad}`, already_booted: true })
  expect(await send(profile, boot(id, `ios-sim:${samples.ipad}`, 'case-boot'))).toMatchObject({ already_booted: true })
  expect(await host.calls()).toEqual([])
})
