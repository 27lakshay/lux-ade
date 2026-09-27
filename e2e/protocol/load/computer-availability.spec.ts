// F098 (availability only): computer and screen access report what this Mac
// allows, explicitly and without asking. The daemon reads the screen
// recording and accessibility permission state with the macOS preflight
// calls, which never show a prompt; this spec requests no permission, captures
// no display and sends no input to the user's session. Display and
// application control are not built, so they must be reported unavailable
// and refused, never approximated by whatever has focus.
import { expect, test } from '../fixtures'
import { capability, deviceProfile, family, inventory, send } from '../devices/steps'

test('F098: computer availability is explicit and stable across listings, the CLI and a daemon restart; application targets and display input are refused', async ({ ade }) => {
  const { profile } = await deviceProfile(ade)
  const first = await inventory(profile, 'computer')
  const computer = family(first, 'computer')
  const permissions = computer.permissions.map(({ permission, state, subject }) => ({ permission, state, subject }))
  expect(permissions.map((entry) => entry.permission).sort()).toEqual(['accessibility', 'screen_recording'])
  for (const entry of permissions) {
    expect(['granted', 'denied']).toContain(entry.state)
    expect(entry.subject).toBeTruthy()
  }
  const displays = first.devices.filter((entry) => entry.family === 'computer')

  // A second listing, the CLI and a new daemon report the same state: reading it changes nothing.
  const summary = (list: typeof first) => ({
    host: list.host.host_id,
    permissions: family(list, 'computer').permissions.map(({ permission, state }) => ({ permission, state })),
    displays: list.devices.filter((entry) => entry.family === 'computer').map((entry) => ({ id: entry.device_id,
      capabilities: entry.capabilities.map(({ capability: name, available, reason }) => ({ name, available, code: reason?.code ?? null })) })),
  })
  expect(summary(await inventory(profile, 'computer'))).toEqual(summary(first))
  const cli = await profile.cli('device', 'list', '--family', 'computer')
  expect(cli.code, cli.stderr).toBe(0)
  expect(summary(cli.json as unknown as typeof first)).toEqual(summary(first))
  await profile.restartDaemon()
  expect(summary(await inventory(profile, 'computer'))).toEqual(summary(first))

  // Display input is unavailable with a reason on every display, and refused with it.
  const host = first.host.host_id
  for (const display of displays) {
    const input = capability(display, 'input')
    expect(input.available).toBe(false)
    expect(['permission_denied', 'not_supported']).toContain(input.reason?.code)
    const refused = await send(profile, { op: 'device.input', operation_id: `f098-${display.device_id}`, host_id: host,
      device_id: display.device_id, caller: { kind: 'user' }, action: { kind: 'tap', x: 1, y: 1 } })
    expect(refused).toMatchObject({ type: 'error' })
    expect(refused.message).toContain(`(${input.reason?.code})`)
  }

  // An application target is not a device identity: it is refused before anything runs, and
  // never redirected to a display or to the focused application.
  for (const target of ['app:com.apple.TextEdit', 'window:1', 'focused']) {
    for (const request of [
      { op: 'device.input', operation_id: `f098-app-${target}`, host_id: host, device_id: target, caller: { kind: 'user' },
        action: { kind: 'text', text: 'never typed' } },
      { op: 'device.screenshot', host_id: host, device_id: target },
    ]) {
      const refused = await send(profile, request)
      expect(refused).toMatchObject({ type: 'error' })
      expect(refused.message).toMatch(/not a device identity|no kind prefix/)
    }
  }
  // A refusal keeps no receipt: the same operation ID aimed at a display gets that display's own reason.
  if (displays.length > 0) {
    const reason = capability(displays[0]!, 'input').reason?.code
    const reused = await send(profile, { op: 'device.input', operation_id: 'f098-app-app:com.apple.TextEdit', host_id: host,
      device_id: displays[0]!.device_id, caller: { kind: 'user' }, action: { kind: 'tap', x: 1, y: 1 } })
    expect(reused.message).toContain(`(${reason})`)
  }
})
