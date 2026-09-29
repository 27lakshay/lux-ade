// Android devices and emulators (F100; decision D12; spec story 08-S12).
// The Android SDK root is a fixture whose adb, emulator and aapt2 are shims
// returning recorded output. Boot, install and launch are effect commands
// with receipts and replay. A device that disconnects, or whose port-number
// serial now belongs to another AVD, fails its next operation without the
// daemon acting on the device that took its place.
import { expect, test } from '../fixtures'
import { boot, capability, device, deviceProfile, hostId, install, inventory, launch, send } from './steps'

const pixel = 'android-avd:Pixel_9_Pro'
const tablet = 'android-avd:Tablet_API_35'

test('boot an AVD, install an APK, launch it and capture it; replays never rerun adb or the emulator', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const apk = await host.apk('demo', 'com.example.demo', '12')

  const booted = await profile.call('device.boot', {
    operation_id: 'boot-avd',
    host_id: id,
    device_id: pixel,
    timeout_ms: 30_000,
  })
  expect(booted).toMatchObject({
    type: 'device_booted',
    device_id: pixel,
    already_booted: false,
    serial: 'emulator-5556',
  })
  expect((await host.calls('emulator'))[0].args).toEqual(['-avd', 'Pixel_9_Pro'])
  const listed = device(await inventory(profile, 'android'), pixel)
  expect(listed).toMatchObject({ state: 'booted', serial: 'emulator-5556' })

  const installed = await profile.call('device.app.install', {
    operation_id: 'install-apk',
    host_id: id,
    device_id: pixel,
    app_path: apk,
  })
  expect(installed).toMatchObject({ type: 'device_app_installed', app_id: 'com.example.demo', version: '12' })
  expect((await host.calls('adb', 'install'))[0].args).toEqual(['-s', 'emulator-5556', 'install', '-r', apk])

  const launched = await profile.call('device.app.launch', {
    operation_id: 'launch-apk',
    host_id: id,
    device_id: pixel,
    app_id: 'com.example.demo',
  })
  expect(launched.pid).toBe((await host.calls('adb', 'am'))[0].launched_pid)
  expect((await host.calls('adb', 'am'))[0].args).toEqual([
    '-s',
    'emulator-5556',
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    'com.example.demo/.MainActivity',
  ])

  const shot = await profile.call('device.screenshot', { host_id: id, device_id: pixel })
  expect(shot).toMatchObject({ width: 1080, height: 2400, mime: 'image/png' })

  expect(
    await profile.call('device.boot', { operation_id: 'boot-avd', host_id: id, device_id: pixel, timeout_ms: 30_000 }),
  ).toEqual(booted)
  expect(
    await profile.call('device.app.install', {
      operation_id: 'install-apk',
      host_id: id,
      device_id: pixel,
      app_path: apk,
    }),
  ).toEqual(installed)
  const cli = await profile.cli('device', 'launch', id, pixel, 'com.example.demo', '--operation-id', 'launch-apk')
  expect(cli.json).toMatchObject({ pid: launched.pid })
  expect(await host.calls('emulator')).toHaveLength(1)
  expect(await host.calls('adb', 'install')).toHaveLength(1)
  expect(await host.calls('adb', 'am')).toHaveLength(1)

  // The CLI installs through the same effect path.
  const update = await host.apk('demo-13', 'com.example.demo', '13')
  const cliInstall = await profile.cli('device', 'install', id, pixel, update, '--operation-id', 'install-13')
  expect(cliInstall.json).toMatchObject({ app_id: 'com.example.demo', version: '13' })
  expect(await host.calls('adb', 'install')).toHaveLength(2)

  // A booted AVD cannot be booted again, and a physical device is never booted.
  expect(await send(profile, boot(id, tablet, 'boot-tablet'))).toMatchObject({
    type: 'device_booted',
    already_booted: true,
    serial: 'emulator-5554',
  })
  expect((await send(profile, boot(id, 'android-serial:R58M123456', 'boot-phone'))).message).toContain(
    '(not_supported)',
  )
})

test('unauthorized, offline and permission-less devices refuse effects with their reason', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const apk = await host.apk('demo', 'com.example.demo', '1')
  const cases: Array<[string, string]> = [
    ['android-serial:R58M123456', 'device_unauthorized'],
    ['android-serial:0A1B2C3D', 'device_offline'],
    ['android-serial:ZY22ABCDEF', 'device_no_permissions'],
  ]
  for (const [deviceId, code] of cases) {
    expect((await send(profile, install(id, deviceId, `i-${code}`, apk))).message).toContain(`(${code})`)
    expect((await send(profile, launch(id, deviceId, `l-${code}`, 'com.example.demo'))).message).toContain(`(${code})`)
    expect((await send(profile, { op: 'device.screenshot', host_id: id, device_id: deviceId })).message).toContain(
      `(${code})`,
    )
  }
  // Once the user accepts the key, the same operation ID runs: the refusal kept no receipt.
  await host.update((state) => {
    const phone = state.android.devices.find((entry) => entry.serial === 'R58M123456')!
    phone.state = 'device'
    phone.boot_completed = true
    phone.detail = 'usb:1-1 product:husky model:Pixel_8_Pro device:husky transport_id:2'
  })
  const phone = device(await inventory(profile, 'android'), 'android-serial:R58M123456')
  expect(phone).toMatchObject({ kind: 'physical', state: 'booted', name: 'Pixel_8_Pro' })
  expect(capability(phone, 'install_app').available).toBe(true)
  expect(await send(profile, install(id, 'android-serial:R58M123456', 'i-device_unauthorized', apk))).toMatchObject({
    type: 'device_app_installed',
    version: '1',
  })
})

test('a disconnected emulator fails its next operation without touching the AVD that took its serial', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const apk = await host.apk('demo', 'com.example.demo', '3')
  expect(device(await inventory(profile, 'android'), tablet).serial).toBe('emulator-5554')

  // The tablet shuts down and another AVD starts on the same port.
  await host.update((state) => {
    state.android.avds.push('Phone_API_34')
    state.android.devices[0] = {
      serial: 'emulator-5554',
      state: 'device',
      avd: 'Phone_API_34',
      boot_completed: true,
      detail: 'product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:9',
    }
  })
  const list = await inventory(profile, 'android')
  expect(device(list, tablet)).toMatchObject({ state: 'shutdown', serial: null })
  expect(device(list, 'android-avd:Phone_API_34').serial).toBe('emulator-5554')

  for (const request of [
    install(id, tablet, 'gone-install', apk),
    launch(id, tablet, 'gone-launch', 'com.example.demo'),
    { op: 'device.screenshot', host_id: id, device_id: tablet },
  ]) {
    const refused = await send(profile, request)
    expect(refused.message, String(request.op)).toContain(`Device ${tablet} is unavailable (device_not_booted)`)
  }
  // Unplugged entirely: not attached. A serial target never follows another device.
  await host.update((state) => {
    state.android.devices = state.android.devices.filter((entry) => entry.serial !== '0A1B2C3D')
  })
  expect(
    (await send(profile, launch(id, 'android-serial:0A1B2C3D', 'gone-serial', 'com.example.demo'))).message,
  ).toContain('it is not attached to this host now')
  expect(await host.calls('adb')).toEqual([])
})

test('an adb install or launch interrupted by a crash is reconciled from the device, never rerun', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const apk = await host.apk('demo', 'com.example.demo', '4')

  // Crash before adb installed: the device does not report the app, so the replay fails.
  await host.hold('adb-install')
  const lost = send(profile, install(id, tablet, 'install-crash', apk)).catch((error: Error) => error)
  await host.held('adb-install')
  await profile.restartDaemon('kill')
  expect(await lost).toBeInstanceOf(Error)
  const replay = await send(profile, install(id, tablet, 'install-crash', apk))
  expect(replay.message).toContain(
    'The install of com.example.demo 4 was interrupted and the device does not report it; it was not retried',
  )
  expect((await host.calls('adb', 'install')).filter((call) => !call.abandoned)).toHaveLength(0)

  // A new ID installs; a launch interrupted by a crash becomes unknown.
  await profile.call('device.app.install', {
    operation_id: 'install-ok',
    host_id: id,
    device_id: tablet,
    app_path: apk,
  })
  await host.hold('am-start')
  const lostLaunch = send(profile, launch(id, tablet, 'launch-crash', 'com.example.demo')).catch(
    (error: Error) => error,
  )
  await host.held('am-start')
  await profile.restartDaemon('kill')
  expect(await lostLaunch).toBeInstanceOf(Error)
  const unknown = await send(profile, launch(id, tablet, 'launch-crash', 'com.example.demo'))
  expect(unknown.message).toContain('Operation launch-crash outcome is unknown')
  expect((await host.calls('adb', 'am')).filter((call) => !call.abandoned)).toHaveLength(0)
})

test('an AVD boot interrupted by a crash reports the boot failed and does not start the emulator again', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  await host.hold('emulator')
  const lost = send(profile, boot(id, pixel, 'boot-crash', { timeout_ms: 30_000 })).catch((error: Error) => error)
  await host.held('emulator')
  await profile.restartDaemon('kill')
  expect(await lost).toBeInstanceOf(Error)
  // The held emulator saw its parent die and exited without starting.
  await expect.poll(async () => (await host.calls('emulator')).map((call) => call.abandoned)).toEqual(['emulator'])
  const replay = await send(profile, boot(id, pixel, 'boot-crash', { timeout_ms: 30_000 }))
  expect(replay.message).toContain('was interrupted and the device is not booted; it was not retried')
  expect(await host.calls('emulator')).toHaveLength(1)
  expect(device(await inventory(profile, 'android'), pixel).state).toBe('shutdown')
})
