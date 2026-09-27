// Device discovery (F098, F099, F100; decision D12). A real daemon probes a
// fixture host whose xcrun, adb, emulator and aapt2 are PATH and SDK-root
// shims returning recorded tool output. Every family and every capability
// answers available, or unavailable with a reason; missing tools, a broken
// tool and missing runtimes are reported, never papered over. Screen access
// asks the real macOS permission API, so only the explicitness of its answer
// is asserted.
import { expect, test } from '../fixtures'
import { DeviceHost, sampleState, samples } from '../fixtures/devices'
import { boot, capability, device, deviceProfile, family, hostId, install, inventory, launch, send } from './steps'

test('the inventory lists simulators, AVDs and adb devices with a reason for every unavailable capability', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const list = await inventory(profile)
  expect(list.host.host_id).toMatch(/^host-[0-9a-f]{16}$/)
  expect(list.host.platform).toBe('macos')

  // iOS: only iOS runtimes; the watch is not a target.
  const ios = family(list, 'ios_simulator')
  expect(ios).toMatchObject({ available: true, reasons: [], tools: [host.path('xcrun'), host.path('idb')] })
  expect(list.devices.some((entry) => entry.device_id.includes(samples.watch))).toBe(false)

  const iphone = device(list, `ios-sim:${samples.iphone}`)
  expect(iphone).toMatchObject({ kind: 'simulator', state: 'shutdown', runtime: 'iOS 26.4', serial: null })
  expect(capability(iphone, 'boot')).toEqual({ capability: 'boot', available: true, reason: null })
  for (const name of ['screenshot', 'install_app', 'launch_app']) {
    expect(capability(iphone, name)).toMatchObject({ available: false, reason: { code: 'device_not_booted' } })
  }
  const ipad = device(list, `ios-sim:${samples.ipad}`)
  expect(ipad.state).toBe('booted')
  expect(capability(ipad, 'boot')).toMatchObject({ available: false, reason: { code: 'device_booted' } })
  expect(capability(ipad, 'install_app').available).toBe(true)
  const orphan = device(list, `ios-sim:${samples.noRuntime}`)
  for (const status of orphan.capabilities) {
    expect(status).toMatchObject({ available: false, reason: { code: 'runtime_missing' } })
    expect(status.reason?.detail).toContain('runtime profile not found')
  }

  // Android: a running AVD is named by its AVD, not its port-number serial.
  const android = family(list, 'android')
  expect(android.available).toBe(true)
  expect(android.reasons).toEqual([])
  expect(android.tools).toEqual([host.path('adb'), host.path('emulator'), host.path('aapt2')])
  const tablet = device(list, 'android-avd:Tablet_API_35')
  expect(tablet).toMatchObject({ kind: 'emulator', state: 'booted', serial: 'emulator-5554' })
  expect(capability(tablet, 'launch_app').available).toBe(true)
  expect(list.devices.some((entry) => entry.device_id === 'android-serial:emulator-5554')).toBe(false)
  const pixel = device(list, 'android-avd:Pixel_9_Pro')
  expect(pixel).toMatchObject({ state: 'shutdown', serial: null })
  expect(capability(pixel, 'boot').available).toBe(true)
  expect(capability(pixel, 'install_app').reason?.code).toBe('device_not_booted')

  const expectations: Array<[string, string, string]> = [
    ['android-serial:R58M123456', 'unauthorized', 'device_unauthorized'],
    ['android-serial:0A1B2C3D', 'offline', 'device_offline'],
    ['android-serial:ZY22ABCDEF', 'no_permissions', 'device_no_permissions'],
  ]
  for (const [id, state, code] of expectations) {
    const phone = device(list, id)
    expect(phone).toMatchObject({ kind: 'physical', state })
    expect(capability(phone, 'boot').reason?.code).toBe('not_supported')
    for (const name of ['screenshot', 'install_app', 'launch_app']) {
      expect(capability(phone, name)).toMatchObject({ available: false, reason: { code } })
    }
  }

  // Every unavailable capability carries a reason; every available one none.
  for (const entry of list.devices) {
    for (const status of entry.capabilities) {
      expect(status.available ? status.reason : status.reason?.code, `${entry.device_id} ${status.capability}`).toEqual(
        status.available ? null : expect.any(String),
      )
    }
  }

  // The CLI filters by family and reports the same devices.
  const cli = await profile.cli('device', 'list', '--family', 'android')
  expect(cli.code).toBe(0)
  const families = cli.json?.families as Array<{ family: string }>
  expect(families.map((entry) => entry.family)).toEqual(['android'])
  expect((cli.json?.devices as Array<{ device_id: string }>).map((entry) => entry.device_id).sort()).toEqual(
    list.devices
      .filter((entry) => entry.family === 'android')
      .map((entry) => entry.device_id)
      .sort(),
  )
  expect((await profile.cli('device', 'list', '--family', 'watch')).code).not.toBe(0)
})

test('screen access reports the real macOS permission state explicitly', async ({ ade }) => {
  const { profile } = await deviceProfile(ade)
  const list = await inventory(profile, 'computer')
  expect(list.families.map((entry) => entry.family)).toEqual(['computer'])
  const computer = family(list, 'computer')
  const permissions = new Map(computer.permissions.map((entry) => [entry.permission, entry]))
  for (const permission of ['screen_recording', 'accessibility']) {
    expect(['granted', 'denied']).toContain(permissions.get(permission)?.state)
    expect(permissions.get(permission)?.subject).toBeTruthy()
  }
  const displays = list.devices.filter((entry) => entry.family === 'computer')
  if (computer.available) {
    expect(displays.length).toBeGreaterThan(0)
  } else {
    expect(computer.reasons.length).toBeGreaterThan(0)
  }
  for (const display of displays) {
    expect(display.device_id).toMatch(/^display:[0-9A-F-]{36}$/)
    const screenshot = capability(display, 'screenshot')
    if (!screenshot.available) expect(screenshot.reason?.code).toMatch(/^[a-z_]+$/)
    // Denied screen recording must block capture with that reason.
    if (permissions.get('screen_recording')?.state === 'denied') {
      expect(screenshot).toMatchObject({ available: false, reason: { code: 'permission_denied' } })
    }
  }
  // An unavailable display capture is refused with its reason; nothing is captured.
  const id = await hostId(profile)
  for (const display of displays.filter((entry) => !capability(entry, 'screenshot').available)) {
    const refused = await send(profile, { op: 'device.screenshot', host_id: id, device_id: display.device_id })
    expect(refused.type).toBe('error')
    expect(refused.message).toContain(`(${capability(display, 'screenshot').reason?.code})`)
  }
})

test('a host without Xcode or the Android SDK reports both families unavailable with tool_missing', async ({ ade }) => {
  const state = sampleState()
  state.simctl = 'missing'
  const { profile } = await deviceProfile(ade, state, { android: false })
  test.skip(
    (await inventory(profile, 'android')).families[0].tools.length > 0,
    'This machine has adb or the emulator on a standard PATH directory, so an SDK-less host cannot be modelled',
  )

  const list = await inventory(profile)
  const ios = family(list, 'ios_simulator')
  expect(ios).toMatchObject({ available: false, tools: [] })
  expect(ios.reasons).toEqual([{ code: 'tool_missing', detail: expect.stringContaining('Install Xcode') }])
  const android = family(list, 'android')
  expect(android).toMatchObject({ available: false, tools: [] })
  expect(android.reasons.map((reason) => reason.code)).toEqual(['tool_missing', 'tool_missing', 'tool_missing'])
  expect(android.reasons.map((reason) => reason.detail).join('\n')).toMatch(
    /adb was not found[\s\S]*emulator[\s\S]*aapt2/,
  )
  expect(list.devices.filter((entry) => entry.family !== 'computer')).toEqual([])

  // Targeted effects are refused before any receipt: the same IDs work once the tools arrive.
  const id = list.host.host_id
  const refused = await send(profile, boot(id, `ios-sim:${samples.iphone}`, 'boot-1'))
  expect(refused).toMatchObject({ type: 'error' })
  expect(refused.message).toContain('not attached to this host')
  const android2 = await send(profile, boot(id, 'android-avd:Pixel_9_Pro', 'boot-2'))
  expect(android2.message).toContain('not attached to this host')
})

test('a failing simctl is reported as tool_failed, and a host with no runtimes as runtime_missing', async ({ ade }) => {
  const state = sampleState()
  state.simctl = 'failed'
  state.android = { devices: [], avds: [] }
  const { host, profile } = await deviceProfile(ade, state)
  let list = await inventory(profile)
  expect(family(list, 'ios_simulator')).toMatchObject({
    available: false,
    reasons: [
      { code: 'tool_failed', detail: expect.stringContaining('xcrun simctl failed: An error was encountered') },
    ],
  })
  expect(family(list, 'android')).toMatchObject({
    available: false,
    reasons: [{ code: 'runtime_missing', detail: 'No Android device is connected and no AVD exists' }],
  })

  // Only simulators without an installed runtime: the family says why.
  await host.update((next) => {
    next.simctl = 'ok'
    next.simulators = next.simulators.filter((sim) => sim.udid === samples.noRuntime)
  })
  list = await inventory(profile, 'ios_simulator')
  expect(family(list, 'ios_simulator')).toMatchObject({
    available: false,
    reasons: [{ code: 'runtime_missing', detail: expect.stringContaining('Install one in Xcode') }],
  })
  await host.update((next) => {
    next.simulators = []
  })
  list = await inventory(profile, 'ios_simulator')
  expect(family(list, 'ios_simulator').reasons).toEqual([
    { code: 'runtime_missing', detail: expect.stringContaining('No iOS simulators exist') },
  ])
})

test('targeted operations name this host and an exact device, and refusals leave no receipt', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const iphone = `ios-sim:${samples.iphone}`

  // Another host's ID is refused for every targeted operation.
  const other = 'host-0000000000000000'
  for (const request of [
    boot(other, iphone, 'op-host'),
    install(other, iphone, 'op-host-i', '/tmp/x.app'),
    launch(other, iphone, 'op-host-l', 'com.example.app'),
    { op: 'device.screenshot', host_id: other, device_id: iphone },
  ]) {
    const refused = await send(profile, request)
    expect(refused.type, String(request.op)).toBe('error')
    expect(refused.message).toMatch(/host/i)
  }
  // A device ID must be one of the listed shapes; the SDK contract and the daemon both refuse others.
  for (const bad of ['iphone', 'ios-sim:not-a-udid', 'android-avd:../x', `display:${samples.iphone}x`]) {
    const refused = await send(profile, boot(id, bad, `op-${bad}`))
    expect(refused.type, bad).toBe('error')
  }
  // A capability the device cannot take now is refused with its reason.
  const notBooted = await send(
    profile,
    install(id, iphone, 'op-install', await host.app('Demo', 'com.example.demo', '3')),
  )
  expect(notBooted.message).toContain('(device_not_booted)')
  const noRuntime = await send(profile, boot(id, `ios-sim:${samples.noRuntime}`, 'op-runtime'))
  expect(noRuntime.message).toContain('(runtime_missing)')
  const unauthorized = await send(profile, launch(id, 'android-serial:R58M123456', 'op-unauth', 'com.example.app'))
  expect(unauthorized.message).toContain('(device_unauthorized)')
  expect(await host.calls()).toEqual([])

  // The refused operation IDs were not consumed: the host-refused boot now runs.
  const booted = await send(profile, boot(id, iphone, 'op-host'))
  expect(booted).toMatchObject({ type: 'device_booted', already_booted: false, device_id: iphone })
  expect(await host.calls('xcrun', 'bootstatus')).toHaveLength(1)
})

test('the host identity is stable across daemon restarts and across profiles on one machine', async ({ ade }) => {
  const host = await DeviceHost.create(ade.root)
  const first = await ade.profile({ env: host.env() })
  const second = await ade.profile({ env: host.env() })
  const id = await hostId(first)
  expect(await hostId(second)).toBe(id)
  await first.restartDaemon('kill')
  expect(await hostId(first)).toBe(id)
})
