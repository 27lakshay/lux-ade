// Device control (F098, F099, F100 "view/control"; decision D12; 08-S12).
// `device.input` sends one tap, swipe, text or key event to one exact booted
// device. It is an effect command: an operation ID, a receipt, replay without
// resending, conflict on other parameters, and an unknown outcome after a
// crash, because whether an input arrived cannot be observed. Every input
// records who asked. The simulator (`idb`) and Android (`adb`) tools are PATH
// and SDK-root shims from `fixtures/device_tools.py`; no real device is used.
import { expect, test, type ScratchProfile } from '../fixtures'
import { samples } from '../fixtures/devices'
import { capability, device, deviceProfile, hostId, inventory, resolveQuarantine, send } from '../devices/steps'

const tablet = 'android-avd:Tablet_API_35'
const pixel = 'android-avd:Pixel_9_Pro'
const ipad = `ios-sim:${samples.ipad}`
const iphone = `ios-sim:${samples.iphone}`
type Caller = { kind: 'user' } | { kind: 'agent'; conversation_id: string }
const user: Caller = { kind: 'user' }

type Action =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: 'home' | 'back' | 'enter' | 'delete' | 'tab' | 'escape' }
  | { kind: 'swipe'; from_x: number; from_y: number; to_x: number; to_y: number; duration_ms?: number }

const input = (host: string, deviceId: string, operationId: string, action: Action, caller: Caller = user) => ({
  op: 'device.input' as const,
  ...fields(host, deviceId, operationId, action, caller),
})
const fields = (host: string, deviceId: string, operationId: string, action: Action, caller: Caller = user) => ({
  operation_id: operationId,
  host_id: host,
  device_id: deviceId,
  caller,
  action,
})

/** A real Conversation, so an Agent caller names one that exists. */
async function conversation(profile: ScratchProfile): Promise<string> {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const created = await profile.call('conversation.create', { workspace_id: workspace.id, provider: 'codex' })
  return created.conversation.id
}

test('F100: input reaches only the selected Android device, attributed to its caller; replays never resend', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const list = await inventory(profile, 'android')
  expect(capability(device(list, tablet), 'input')).toEqual({ capability: 'input', available: true, reason: null })
  expect(capability(device(list, pixel), 'input').reason?.code).toBe('device_not_booted')

  const tapped = await profile.call('device.input', fields(id, tablet, 'tap-1', { kind: 'tap', x: 540, y: 1200 }))
  expect(tapped).toEqual({
    type: 'device_input_sent',
    operation_id: 'tap-1',
    host_id: id,
    device_id: tablet,
    action: { kind: 'tap', x: 540, y: 1200 },
    attribution: 'user',
    serial: 'emulator-5554',
  })
  expect((await host.calls('adb', 'input')).map((call) => call.args)).toEqual([
    ['-s', 'emulator-5554', 'shell', 'input', 'tap', '540', '1200'],
  ])

  // An Agent caller is recorded as that Conversation; an invented one is refused before anything runs.
  const conversationId = await conversation(profile)
  const typed = await profile.call(
    'device.input',
    fields(
      id,
      tablet,
      'text-1',
      { kind: 'text', text: "it's a b" },
      { kind: 'agent', conversation_id: conversationId },
    ),
  )
  expect(typed.attribution).toBe(`agent:${conversationId}`)
  // The device shell receives one quoted word; spaces become %s for `input text`.
  expect((await host.calls('adb', 'input')).at(-1)?.input).toEqual(['text', "'it'\\''s%sa%sb'"])
  const invented = await send(
    profile,
    input(
      id,
      tablet,
      'text-2',
      { kind: 'text', text: 'x' },
      { kind: 'agent', conversation_id: 'no-such-conversation' },
    ),
  )
  expect(invented.message).toContain('Caller Conversation no-such-conversation does not exist')
  expect(await host.calls('adb', 'input')).toHaveLength(2)
  // The refusal kept no receipt: the same ID runs for a real caller.
  expect(await send(profile, input(id, tablet, 'text-2', { kind: 'text', text: 'x' }))).toMatchObject({
    type: 'device_input_sent',
    attribution: 'user',
  })

  await profile.call(
    'device.input',
    fields(id, tablet, 'swipe-1', { kind: 'swipe', from_x: 10, from_y: 2000, to_x: 10, to_y: 400, duration_ms: 250 }),
  )
  expect((await host.calls('adb', 'input')).at(-1)?.input).toEqual(['swipe', '10', '2000', '10', '400', '250'])

  // The CLI sends a key with Agent attribution through the same effect path.
  const cli = await profile.cli(
    'device',
    'input',
    id,
    tablet,
    '--key',
    'back',
    '--agent',
    conversationId,
    '--operation-id',
    'key-1',
  )
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({
    type: 'device_input_sent',
    action: { kind: 'key', key: 'back' },
    attribution: `agent:${conversationId}`,
  })
  expect((await host.calls('adb', 'input')).at(-1)?.input).toEqual(['keyevent', 'KEYCODE_BACK'])

  // Replays return the receipt without resending; other parameters under the same ID conflict.
  const before = (await host.calls('adb', 'input')).length
  expect(await profile.call('device.input', fields(id, tablet, 'tap-1', { kind: 'tap', x: 540, y: 1200 }))).toEqual(
    tapped,
  )
  expect(
    (await profile.cli('device', 'input', id, tablet, '--tap', '540,1200', '--operation-id', 'tap-1')).json,
  ).toEqual(tapped)
  const conflict = await send(profile, input(id, tablet, 'tap-1', { kind: 'tap', x: 1, y: 1 }))
  expect(conflict.message).toContain('already used for different parameters')
  expect(await host.calls('adb', 'input')).toHaveLength(before)

  // Bad input is refused before a receipt or a tool run.
  for (const [opId, action, message] of [
    ['bad-1', { kind: 'tap', x: 100_001, y: 0 }, 'at most 100000'],
    ['bad-2', { kind: 'text', text: 'café' }, 'printable ASCII'],
    ['bad-3', { kind: 'text', text: '50%s off' }, 'cannot contain'],
  ] as Array<[string, Action, string]>) {
    expect((await send(profile, input(id, tablet, opId, action))).message).toContain(message)
  }
  expect(await host.calls('adb', 'input')).toHaveLength(before)

  // A device-side failure is a settled failure, and replays as that failure.
  await host.update((state) => {
    state.input_error = 'Injecting to another application requires INJECT_EVENTS permission'
  })
  const failed = await send(profile, input(id, tablet, 'tap-fail', { kind: 'tap', x: 1, y: 1 }))
  expect(failed.message).toContain('Input failed: Error: Injecting to another application')
  await host.update((state) => {
    delete state.input_error
  })
  expect((await send(profile, input(id, tablet, 'tap-fail', { kind: 'tap', x: 1, y: 1 }))).message).toContain(
    'Input failed: Error: Injecting',
  )
})

test('F100/08-S12: unauthorized, offline and disconnected devices refuse input without touching another device', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  for (const [deviceId, code] of [
    ['android-serial:R58M123456', 'device_unauthorized'],
    ['android-serial:0A1B2C3D', 'device_offline'],
    ['android-serial:ZY22ABCDEF', 'device_no_permissions'],
    [pixel, 'device_not_booted'],
  ]) {
    expect(
      (await send(profile, input(id, deviceId, `refused-${code}`, { kind: 'tap', x: 1, y: 1 }))).message,
    ).toContain(`Device ${deviceId} is unavailable (${code})`)
  }
  // Another host is never relayed to.
  expect(
    (await send(profile, input('host-0000000000000000', tablet, 'other-host', { kind: 'tap', x: 1, y: 1 }))).message,
  ).toContain("is not this daemon's host")

  // The tablet closes and another AVD boots on its port-number serial.
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
  expect((await send(profile, input(id, tablet, 'after-close', { kind: 'tap', x: 1, y: 1 }))).message).toContain(
    `Device ${tablet} is unavailable (device_not_booted)`,
  )
  // Unplugged entirely: the serial target is not attached, and nothing follows another device.
  await host.update((state) => {
    state.android.devices = state.android.devices.filter((entry) => entry.serial !== 'R58M123456')
  })
  expect(
    (await send(profile, input(id, 'android-serial:R58M123456', 'unplugged', { kind: 'tap', x: 1, y: 1 }))).message,
  ).toContain('it is not attached to this host now')
  expect(await host.calls('adb', 'input')).toEqual([])

  // Once the key is accepted, the refused operation ID runs: refusals keep no receipt.
  await host.update((state) => {
    state.android.devices.push({
      serial: 'R58M123456',
      state: 'device',
      boot_completed: true,
      detail: 'usb:1-1 product:husky model:Pixel_8_Pro device:husky transport_id:2',
    })
  })
  expect(
    await send(
      profile,
      input(id, 'android-serial:R58M123456', 'refused-device_unauthorized', { kind: 'tap', x: 1, y: 1 }),
    ),
  ).toMatchObject({ type: 'device_input_sent', serial: 'R58M123456' })
  expect((await host.calls('adb', 'input')).map((call) => call.serial)).toEqual(['R58M123456'])
})

test('F100 faults: a duplicate in flight is refused, and an input cut by a daemon crash is unknown and never resent', async ({
  ade,
}) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)

  // While one input runs, its ID and its device are both held.
  await host.hold('adb-input')
  const first = send(profile, input(id, tablet, 'held-1', { kind: 'tap', x: 5, y: 5 }))
  await host.held('adb-input')
  expect((await send(profile, input(id, tablet, 'held-1', { kind: 'tap', x: 5, y: 5 }))).message).toContain(
    'Operation held-1 is still running',
  )
  expect((await send(profile, input(id, tablet, 'held-2', { kind: 'tap', x: 6, y: 6 }))).message).toContain(
    `Another device operation is running on ${tablet}`,
  )
  await host.release('adb-input')
  expect(await first).toMatchObject({ type: 'device_input_sent', operation_id: 'held-1' })
  expect(await host.calls('adb', 'input')).toHaveLength(1)

  // The daemon dies while adb holds the event: the outcome cannot be observed.
  await host.hold('adb-input')
  const lost = send(profile, input(id, tablet, 'crash-1', { kind: 'text', text: 'hello' })).catch(
    (error: Error) => error,
  )
  await host.held('adb-input')
  await profile.restartDaemon('kill')
  expect(await lost).toBeInstanceOf(Error)
  await expect.poll(async () => (await host.calls('adb')).filter((call) => call.abandoned).length).toBe(1)
  const unknown = await send(profile, input(id, tablet, 'crash-1', { kind: 'text', text: 'hello' }))
  expect(unknown.message).toContain('Operation crash-1 outcome is unknown')
  expect(unknown.message).toContain('It was not run again')
  // The unknown outcome quarantines the emulator: a new ID is refused until the caller resolves it.
  const blocked = await send(profile, input(id, tablet, 'crash-2', { kind: 'text', text: 'hello' }))
  expect(blocked.type).toBe('error')
  await resolveQuarantine(profile, tablet, 'resolve-crash-1')
  expect(await send(profile, input(id, tablet, 'crash-2', { kind: 'text', text: 'hello' }))).toMatchObject({
    type: 'device_input_sent',
  })
  expect((await host.calls('adb', 'input')).filter((call) => !call.abandoned)).toHaveLength(2)
  // Replaying the unknown ID still never resends.
  expect((await send(profile, input(id, tablet, 'crash-1', { kind: 'text', text: 'hello' }))).message).toContain(
    'outcome is unknown',
  )
  expect((await host.calls('adb', 'input')).filter((call) => !call.abandoned)).toHaveLength(2)
})

test('F099: input reaches only the selected simulator through idb, with its host identity', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  const list = await inventory(profile, 'ios_simulator')
  expect(capability(device(list, ipad), 'input').available).toBe(true)
  expect(capability(device(list, iphone), 'input').reason?.code).toBe('device_not_booted')
  expect(capability(device(list, `ios-sim:${samples.noRuntime}`), 'input').reason?.code).toBe('runtime_missing')

  const tapped = await profile.call('device.input', fields(id, ipad, 'sim-tap', { kind: 'tap', x: 200, y: 400 }))
  expect(tapped).toMatchObject({ type: 'device_input_sent', device_id: ipad, attribution: 'user', serial: null })
  await profile.call('device.input', fields(id, ipad, 'sim-text', { kind: 'text', text: 'hello world' }))
  await profile.call('device.input', fields(id, ipad, 'sim-home', { kind: 'key', key: 'home' }))
  // A lowercase UDID names the same simulator, and replays the same receipt.
  expect(
    await profile.call('device.input', fields(id, ipad.toLowerCase(), 'sim-tap', { kind: 'tap', x: 200, y: 400 })),
  ).toEqual(tapped)
  const cli = await profile.cli('device', 'input', id, ipad, '--swipe', '10,600,10,100', '--operation-id', 'sim-swipe')
  expect(cli.json).toMatchObject({ action: { kind: 'swipe', from_x: 10, from_y: 600, to_x: 10, to_y: 100 } })
  const calls = await host.calls('idb')
  expect(calls.map((call) => call.udid)).toEqual([samples.ipad, samples.ipad, samples.ipad, samples.ipad])
  expect(calls.map((call) => call.input)).toEqual([
    ['tap', '200', '400'],
    ['text', 'hello world'],
    ['button', 'HOME'],
    ['swipe', '10', '600', '10', '100', '--duration', '0.300'],
  ])

  // A shut-down simulator, a missing Back key and a simulator deleted after listing are refused; idb never runs.
  expect((await send(profile, input(id, iphone, 'sim-off', { kind: 'tap', x: 1, y: 1 }))).message).toContain(
    `Device ${iphone} is unavailable (device_not_booted)`,
  )
  expect((await send(profile, input(id, ipad, 'sim-back', { kind: 'key', key: 'back' }))).message).toContain(
    'no Back key',
  )
  await host.update((state) => {
    state.simulators = state.simulators.filter((sim) => sim.udid !== samples.ipad)
  })
  expect((await send(profile, input(id, ipad, 'sim-gone', { kind: 'tap', x: 1, y: 1 }))).message).toContain(
    'it is not attached to this host now',
  )
  expect(await host.calls('idb')).toHaveLength(4)
})

test('F099 fault: a simulator input cut by a daemon crash is unknown and never resent', async ({ ade }) => {
  const { host, profile } = await deviceProfile(ade)
  const id = await hostId(profile)
  await host.hold('idb-input')
  const lost = send(profile, input(id, ipad, 'sim-crash', { kind: 'tap', x: 1, y: 2 })).catch((error: Error) => error)
  await host.held('idb-input')
  await profile.killDaemon()
  await expect.poll(async () => (await host.calls('idb')).map((call) => call.abandoned)).toEqual(['idb-input'])
  await profile.restartDaemon()
  expect(await lost).toBeInstanceOf(Error)
  expect((await send(profile, input(id, ipad, 'sim-crash', { kind: 'tap', x: 1, y: 2 }))).message).toContain(
    'Operation sim-crash outcome is unknown',
  )
  expect((await host.calls('idb')).filter((call) => !call.abandoned)).toEqual([])
})

test('F099: without idb, simulator input is unavailable and names the tool', async ({ ade }) => {
  const { DeviceHost, sampleState } = await import('../fixtures/devices')
  const host = await DeviceHost.create(ade.root, sampleState(), { idb: false })
  const profile = await ade.profile({ env: host.env() })
  const list = await inventory(profile, 'ios_simulator')
  test.skip(
    list.families[0].tools.some((tool) => tool.endsWith('/idb')),
    'This machine has idb on a standard PATH directory, so a host without it cannot be modelled',
  )
  const reason = capability(device(list, ipad), 'input').reason
  expect(reason).toMatchObject({ code: 'tool_missing', detail: expect.stringContaining('idb') })
  // Viewing still works without idb.
  expect(capability(device(list, ipad), 'screenshot').available).toBe(true)
  expect(
    (await send(profile, input(list.host.host_id, ipad, 'no-idb', { kind: 'tap', x: 1, y: 1 }))).message,
  ).toContain('(tool_missing)')
})

test('F098: display input is offered by no display, and a request for it is refused with its reason', async ({
  ade: _ade,
  profile,
}) => {
  const list = await inventory(profile, 'computer')
  const id = list.host.host_id
  for (const display of list.devices) {
    const status = capability(display, 'input')
    expect(status.available).toBe(false)
    expect(['permission_denied', 'not_supported']).toContain(status.reason?.code)
    const refused = await send(
      profile,
      input(id, display.device_id, `display-${display.device_id}`, { kind: 'tap', x: 1, y: 1 }),
    )
    expect(refused.message).toContain(`(${status.reason?.code})`)
  }
})
