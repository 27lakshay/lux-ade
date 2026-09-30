import { queryProgram } from '../fixtures/appearance'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, primaryShell, test } from '../fixtures'
import { openView } from './viewer'
import { rawReply } from '../fixtures/raw-reply'
import { replayText, type TerminalFrame } from '../fixtures/terminals'

test('a terminal program sees Chalk colors and light scheme before a rendering view mounts', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'light' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const script = join(profile.root, 'query-appearance.py')
  writeFileSync(script, queryProgram)
  const sent = await profile.cli('terminal', 'send', workspace.id, terminalId, `python3 '${script}'`)
  expect(sent.code, sent.stderr).toBe(0)
  await expect
    .poll(async () =>
      replayText((await profile.cli('terminal', 'inspect', workspace.id, terminalId)).json as TerminalFrame),
    )
    .toContain('APPEARANCE:')
  // The program has already received its replies; only now mount a WASM view.
  const view = await openView(profile, workspace.id, terminalId)
  const screen = await view.until('appearance replies', (state) =>
    state.lines.some((line) => line.startsWith('APPEARANCE:')),
  )
  const reply = Buffer.from(
    screen.lines
      .join('')
      .split('APPEARANCE:')[1]!
      .match(/^[a-f0-9]+/)![0],
    'hex',
  ).toString()
  // Literal values from the approved Chalk handoff, expanded to OSC's 16-bit channels.
  expect(reply).toContain('\x1b]10;rgb:2020/2424/2b2b')
  expect(reply).toContain('\x1b]11;rgb:e8e8/ebeb/efef')
  expect(reply).toContain('\x1b]12;rgb:2020/2424/2b2b')
  expect(reply).toContain('\x1b[?997;2n')
  expect(view.viewer.screen.snapshot().foreground).toEqual({ r: 32, g: 36, b: 43 })
  await profile.call('settings.set', { appearance: 'dark' })
  await expect.poll(() => view.viewer.screen.snapshot().foreground).toEqual({ r: 236, g: 238, b: 242 })
  view.dispose()
})

test('a fixed dark profile terminal binding stays independent of light app colors', async ({ profile }) => {
  const selected = await rawReply(profile, {
    op: 'settings.set',
    appearance: 'light',
    terminal_binding: { kind: 'fixed', theme_id: 'ade:graphite' },
  })
  expect(selected.type).toBe('settings')
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const script = join(profile.root, 'query-fixed-appearance.py')
  writeFileSync(script, queryProgram)
  const sent = await profile.cli('terminal', 'send', workspace.id, terminalId, `python3 '${script}'`)
  expect(sent.code, sent.stderr).toBe(0)
  await expect
    .poll(async () =>
      replayText((await profile.cli('terminal', 'inspect', workspace.id, terminalId)).json as TerminalFrame),
    )
    .toContain('APPEARANCE:')
  const first = await openView(profile, workspace.id, terminalId)
  const second = await openView(profile, workspace.id, terminalId)
  try {
    const screen = await first.until('fixed terminal replies', (state) =>
      state.lines.some((line) => line.startsWith('APPEARANCE:')),
    )
    const reply = Buffer.from(
      screen.lines
        .join('')
        .split('APPEARANCE:')[1]!
        .match(/^[a-f0-9]+/)![0],
      'hex',
    ).toString()
    expect(reply).toContain('\x1b]10;rgb:ecec/eeee/f2f2')
    expect(reply).toContain('\x1b[?997;1n')
    const graphite = { r: 236, g: 238, b: 242 }
    expect(first.viewer.screen.snapshot().foreground).toEqual(graphite)
    expect(second.viewer.screen.snapshot().foreground).toEqual(graphite)
    await profile.call('settings.set', { app_light_theme: 'ade:linen' })
    expect((await profile.call('settings.appearance', {})).mode).toBe('light')
    expect(first.viewer.screen.snapshot().foreground).toEqual(graphite)
    const paired = await profile.cli(
      'settings',
      'set',
      'terminal_binding',
      JSON.stringify({ kind: 'paired', light: 'ade:chalk', dark: 'ade:carbon' }),
    )
    expect(paired.code, paired.stderr).toBe(0)
    await expect.poll(() => first.viewer.screen.snapshot().foreground).toEqual({ r: 32, g: 36, b: 43 })
    await expect.poll(() => second.viewer.screen.snapshot().foreground).toEqual({ r: 32, g: 36, b: 43 })
    const revision = (await profile.call('settings.get', {})).settings.appearance_revision
    for (const binding of [
      { kind: 'fixed', theme_id: 'absent' },
      { kind: 'paired', light: 'ade:graphite', dark: 'ade:carbon' },
    ]) {
      expect((await rawReply(profile, { op: 'settings.set', terminal_binding: binding })).type).toBe('error')
      expect((await profile.call('settings.get', {})).settings.appearance_revision).toBe(revision)
    }
    await profile.restartDaemon('kill')
    expect((await profile.call('settings.appearance', {})).terminal.dark).toBe(false)
    const restored = await openView(profile, workspace.id, terminalId)
    try {
      expect(restored.viewer.screen.snapshot().foreground).toEqual({ r: 32, g: 36, b: 43 })
    } finally {
      restored.dispose()
    }
    await profile.call('settings.appearance.reset', { expected_appearance_revision: revision })
    expect((await profile.call('settings.appearance', {})).terminal.dark).toBe(true)
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('terminal record overrides survive profile changes, detach, daemon replacement and shell restart', async ({
  profile,
}) => {
  await profile.call('settings.set', { appearance: 'light' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const primary = await primaryShell(profile, workspace.id)
  const { terminal_id: other } = await profile.call('terminal.create', { workspace_id: workspace.id })
  const change = (binding: unknown, revision: number) =>
    rawReply(profile, {
      op: 'terminal.appearance.set',
      workspace_id: workspace.id,
      terminal_id: other,
      binding,
      expected_appearance_revision: revision,
    })
  const revision = (await profile.call('settings.get', {})).settings.appearance_revision
  const saved = await change({ kind: 'fixed', theme_id: 'ade:graphite' }, revision)
  expect(saved.type).toBe('terminal_appearance')
  expect(saved).toMatchObject({
    provenance: 'terminal',
    selected_id: 'ade:graphite',
    resolved_id: 'ade:graphite',
    mode: 'dark',
    fallback: false,
  })
  const inspected = await profile.call('terminal.appearance.get', { workspace_id: workspace.id, terminal_id: other })
  expect(inspected).toMatchObject({ provenance: 'terminal', mode: 'dark', propagation: { state: 'applied' } })
  const cli = await profile.cli('terminal', 'appearance', workspace.id, other)
  expect(cli.code, cli.stderr).toBe(0)
  expect(cli.json).toEqual(inspected)
  const script = join(profile.root, 'query-record-appearance.py')
  writeFileSync(script, queryProgram)
  const sent = await profile.cli('terminal', 'send', workspace.id, other, `python3 '${script}'`)
  expect(sent.code, sent.stderr).toBe(0)
  await expect
    .poll(async () => replayText((await profile.cli('terminal', 'inspect', workspace.id, other)).json as TerminalFrame))
    .toContain('APPEARANCE:')
  const views = [await openView(profile, workspace.id, other), await openView(profile, workspace.id, other)]
  const following = await openView(profile, workspace.id, primary)
  try {
    const screen = await views[0]!.until('native override replies', (value) =>
      value.lines.some((line) => line.startsWith('APPEARANCE:')),
    )
    const reply = Buffer.from(
      screen.lines
        .join('')
        .split('APPEARANCE:')[1]!
        .match(/^[a-f0-9]+/)![0],
      'hex',
    ).toString()
    expect(reply).toContain('\x1b]10;rgb:ecec/eeee/f2f2')
    expect(reply).toContain('\x1b[?997;1n')
    for (const view of views) expect(view.viewer.screen.snapshot().foreground).toEqual({ r: 236, g: 238, b: 242 })
    expect(following.viewer.screen.snapshot().foreground).toEqual({ r: 32, g: 36, b: 43 })
    expect((await change(null, revision)).type).toBe('error')
    await profile.call('settings.set', { app_light_theme: 'ade:linen' })
    const committed = await profile.call('settings.appearance', {})
    for (const view of views) {
      await expect
        .poll(() =>
          view.frames.some(
            (frame) =>
              frame.type === 'terminal_appearance' &&
              typeof frame.appearance === 'object' &&
              frame.appearance !== null &&
              'revision' in frame.appearance &&
              frame.appearance.revision === committed.revision,
          ),
        )
        .toBe(true)
      expect(view.viewer.screen.snapshot().foreground).toEqual({ r: 236, g: 238, b: 242 })
    }
    await expect.poll(() => following.viewer.screen.snapshot().foreground).toEqual(committed.terminal.foreground)
    expect(
      (await rawReply(profile, { op: 'terminal.appearance.get', workspace_id: workspace.id, terminal_id: other }))
        .provenance,
    ).toBe('terminal')
  } finally {
    following.dispose()
    for (const view of views) view.dispose()
  }
  await profile.restartDaemon('kill')
  const restored = await openView(profile, workspace.id, other)
  expect(restored.viewer.screen.snapshot().foreground).toEqual({ r: 236, g: 238, b: 242 })
  restored.dispose()
  const stop = await profile.cli('terminal', 'stop', workspace.id, other)
  expect(stop.code, stop.stderr).toBe(0)
  const restart = await profile.cli('terminal', 'restart', workspace.id, other)
  expect(restart.code, restart.stderr).toBe(0)
  const restarted = await openView(profile, workspace.id, other)
  try {
    expect(restarted.viewer.screen.snapshot().foreground).toEqual({ r: 236, g: 238, b: 242 })
    const current = (await profile.call('settings.get', {})).settings.appearance_revision
    const reset = await profile.cli('terminal', 'set-appearance', workspace.id, other, String(current), 'null')
    expect(reset.code, reset.stderr).toBe(0)
    expect(reset.json).toMatchObject({ provenance: 'profile', mode: 'light', resolved_id: 'ade:linen' })
    const expected = (await profile.call('settings.appearance', {})).terminal.foreground
    await expect.poll(() => restarted.viewer.screen.snapshot().foreground).toEqual(expected)
  } finally {
    restarted.dispose()
  }
})

const overrideProgram = String.raw`
import os, select, termios, time, tty
saved = termios.tcgetattr(0)
tty.setraw(0)
def query(label):
    os.write(1, b'\x1b]10;?\x07\x1b[?996n')
    reply = b''
    deadline = time.monotonic() + 5
    while b'\x1b[?997;' not in reply or not reply.endswith(b'n'):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError('terminal did not answer appearance queries')
        reply += os.read(0, 4096)
    os.write(1, ('\r\n' + label + ':' + reply.hex() + '\r\n').encode())
try:
    os.write(1, b'\x1b]10;#123456\x07\r\nOVERRIDE_READY\r\n')
    if not select.select([0], [], [], 10)[0]:
        raise RuntimeError('theme switch was not acknowledged')
    os.read(0, 1)
    query('RETAINED')
    os.write(1, b'\x1b]110\x07')
    query('RESET')
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
`

test('program foreground overrides survive theme changes and reset to the new defaults', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const view = await openView(profile, workspace.id, terminalId)
  try {
    const script = join(profile.root, 'override-appearance.py')
    writeFileSync(script, overrideProgram)
    view.connection.input(`python3 '${script}'\n`)
    await view.until('program installs its foreground override', (state) => state.lines.includes('OVERRIDE_READY'))
    expect(view.viewer.screen.snapshot().foreground).toEqual({ r: 18, g: 52, b: 86 })
    await profile.call('settings.set', { appearance: 'light' })
    await expect.poll(() => view.frames.some((frame) => frame.type === 'terminal_appearance')).toBe(true)
    expect(view.viewer.screen.snapshot().foreground).toEqual({ r: 18, g: 52, b: 86 })
    const attached = await openView(profile, workspace.id, terminalId)
    try {
      expect(attached.viewer.screen.snapshot().foreground).toEqual({ r: 18, g: 52, b: 86 })
    } finally {
      attached.dispose()
    }
    view.connection.input('x')
    const screen = await view.until('program queries retained and reset colors', (state) =>
      state.lines.some((line) => line.startsWith('RESET:')),
    )
    const reply = (label: string) =>
      Buffer.from(
        screen.lines
          .join('')
          .split(`${label}:`)[1]!
          .match(/^[a-f0-9]+/)![0],
        'hex',
      ).toString()
    expect(reply('RETAINED')).toContain('\x1b]10;rgb:1212/3434/5656')
    expect(reply('RETAINED')).toContain('\x1b[?997;2n')
    expect(reply('RESET')).toContain('\x1b]10;rgb:2020/2424/2b2b')
    expect(view.viewer.screen.snapshot().foreground).toEqual({ r: 32, g: 36, b: 43 })
  } finally {
    view.dispose()
  }
})

const notificationProgram = String.raw`
import os, select, termios, time, tty
saved = termios.tcgetattr(0)
tty.setraw(0)
try:
    os.write(1, b'\x1b[?2031h\r\nSCHEME_READY\r\n')
    reply = b''
    deadline = time.monotonic() + 5
    while b'\x1b[?997;2n' not in reply:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError('missing light scheme notification')
        reply += os.read(0, 4096)
    os.write(1, ('\r\nNOTIFIED:' + reply.hex() + '\r\n').encode())
    os.write(1, b'\x1b[?2031l\r\nSCHEME_OFF\r\n')
    reply = b''
    deadline = time.monotonic() + 5
    while not reply.endswith(b'x'):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError('missing input after disabling scheme notifications')
        reply += os.read(0, 4096)
    os.write(1, ('\r\nDISABLED:' + reply.hex() + '\r\n').encode())
finally:
    os.write(1, b'\x1b[?2031l')
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
`

test('a detached terminal receives subscribed scheme changes and can disable reporting', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  let view = await openView(profile, workspace.id, terminalId)
  try {
    const script = join(profile.root, 'scheme-notification.py')
    writeFileSync(script, notificationProgram)
    view.connection.input(`python3 '${script}'\n`)
    await view.until('program subscribes to scheme changes', (state) => state.lines.includes('SCHEME_READY'))
    view.dispose()
    await profile.call('settings.set', { appearance: 'light' })
    await expect
      .poll(async () =>
        replayText((await profile.cli('terminal', 'inspect', workspace.id, terminalId)).json as TerminalFrame),
      )
      .toContain('NOTIFIED:')
    view = await openView(profile, workspace.id, terminalId)
    const screen = await view.until('program receives a scheme notification', (state) =>
      state.lines.some((line) => line.startsWith('NOTIFIED:')),
    )
    const reply = Buffer.from(
      screen.lines
        .join('')
        .split('NOTIFIED:')[1]!
        .match(/^[a-f0-9]+/)![0],
      'hex',
    ).toString()
    expect(reply.match(/\x1b\[\?997;2n/g)).toHaveLength(1)
    await view.until('program disables reporting', (state) => state.lines.includes('SCHEME_OFF'))
    await profile.call('settings.set', { appearance: 'dark' })
    view.connection.input('x')
    await view.until('disabled reporting leaves input untouched', (state) => state.lines.includes('DISABLED:78'))
  } finally {
    view.dispose()
  }
})

const paletteProgram = String.raw`
import hashlib, os, re, select, termios, time, tty
saved = termios.tcgetattr(0)
tty.setraw(0)
def palette_digest():
    os.write(1, ''.join('\x1b]4;%d;?\x07' % i for i in range(256)).encode())
    reply = b''
    deadline = time.monotonic() + 5
    while True:
        matches = re.findall(rb'\x1b\]4;(\d+);rgb:([a-f0-9]{4})/([a-f0-9]{4})/([a-f0-9]{4})', reply)
        if len(matches) == 256:
            colors = {int(index): bytes(int(channel[:2], 16) for channel in (r,g,b)) for index,r,g,b in matches}
            return hashlib.sha256(b''.join(colors[i] for i in range(256))).hexdigest()
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError('missing indexed color replies')
        reply += os.read(0, 16384)
try:
    os.write(1, b'\x1b]4;200;#a1b2c3\x07')
    digest = palette_digest()
    os.write(1, b'\x1b[2J\x1b[H')
    for row in range(16):
        line = '\x1b[0mP%02d ' % row
        line += ''.join('\x1b[38;5;%dmX' % i for i in range(row * 16, row * 16 + 16))
        os.write(1, (line + '\x1b[0m\r\n').encode())
    os.write(1, b'RGB:\x1b[38;2;18;52;86mX\x1b[0m\r\n')
    os.write(1, ('PALETTE_READY:' + digest + '\r\n').encode())
    if not select.select([0], [], [], 10)[0]:
        raise RuntimeError('theme switch was not acknowledged')
    os.read(0, 1)
    os.write(1, ('AFTER:' + palette_digest() + '\r\n').encode())
    os.write(1, b'\x1b]104;200\x07')
    os.write(1, ('RESET_PALETTE:' + palette_digest() + '\r\n').encode())
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
`

test('all 256 indexed colors agree across native queries and WASM while truecolor survives switching', async ({
  profile,
}) => {
  await profile.call('settings.set', { appearance: 'light' })
  const light = await profile.call('settings.appearance', {})
  expect(light.terminal.palette).toHaveLength(256)
  // Independent samples from Ghostty's conventional cube and gray ramp.
  expect(light.terminal.palette[16]).toEqual({ r: 0, g: 0, b: 0 })
  expect(light.terminal.palette[17]).toEqual({ r: 0, g: 0, b: 95 })
  expect(light.terminal.palette[231]).toEqual({ r: 255, g: 255, b: 255 })
  expect(light.terminal.palette[232]).toEqual({ r: 8, g: 8, b: 8 })
  expect(light.terminal.palette[255]).toEqual({ r: 238, g: 238, b: 238 })
  const digest = (palette: ReadonlyArray<(typeof light.terminal.palette)[number]>) =>
    createHash('sha256')
      .update(Buffer.from(palette.flatMap(({ r, g, b }) => [r, g, b])))
      .digest('hex')
  const overridden = (palette: typeof light.terminal.palette) =>
    palette.map((color, index) => (index === 200 ? { r: 161, g: 178, b: 195 } : color))
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const view = await openView(profile, workspace.id, terminalId)
  const colors = () =>
    view.viewer.screen
      .snapshot()
      .rowData.filter((row) => /^P\d\d /.test(row.text))
      .flatMap((row) => row.cells.slice(4, 20).map((cell) => cell.foreground))
  const rgb = () =>
    view.viewer.screen.snapshot().rowData.find((row) => row.text.startsWith('RGB:'))!.cells[4]!.foreground
  try {
    const script = join(profile.root, 'palette-queries.py')
    writeFileSync(script, paletteProgram)
    view.connection.input(`python3 '${script}'\n`)
    await view.until('native palette replies agree with the saved palette', (state) =>
      state.lines.includes(`PALETTE_READY:${digest(overridden(light.terminal.palette))}`),
    )
    expect(colors()).toEqual(overridden(light.terminal.palette))
    expect(rgb()).toEqual({ r: 18, g: 52, b: 86 })
    await profile.call('settings.set', { appearance: 'dark' })
    const dark = await profile.call('settings.appearance', {})
    await expect.poll(colors).toEqual(overridden(dark.terminal.palette))
    expect(rgb()).toEqual({ r: 18, g: 52, b: 86 })
    view.connection.input('x')
    await view.until('native palette queries use the new defaults', (state) =>
      state.lines.includes(`AFTER:${digest(overridden(dark.terminal.palette))}`),
    )
    await view.until('reset reveals the current extended palette defaults', (state) =>
      state.lines.includes(`RESET_PALETTE:${digest(dark.terminal.palette)}`),
    )
    expect(colors()).toEqual(dark.terminal.palette)
    expect(rgb()).toEqual({ r: 18, g: 52, b: 86 })
  } finally {
    view.dispose()
  }
})

test('retiring a terminal removes its runtime appearance override and keeps profile propagation applied', async ({
  profile,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { terminal_id: terminalId } = await profile.call('terminal.create', { workspace_id: workspace.id })
  const revision = (await profile.call('settings.get', {})).settings.appearance_revision
  await profile.call('terminal.appearance.set', {
    workspace_id: workspace.id,
    terminal_id: terminalId,
    expected_appearance_revision: revision,
    binding: { kind: 'fixed', theme_id: 'ade:chalk' },
  })
  expect((await profile.call('settings.appearance', {})).propagation.state).toBe('applied')
  await profile.call('terminal.close', { terminal_id: terminalId, operation_id: 'close-overridden-terminal' })
  expect((await profile.call('settings.appearance', {})).propagation.state).toBe('applied')
})

test('invalid terminal overrides and foreign targets cannot change committed appearance', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const target = { workspace_id: workspace.id, terminal_id: terminalId }
  const before = await profile.call('terminal.appearance.get', target)
  const base = { op: 'terminal.appearance.set', ...target, expected_appearance_revision: before.revision }
  for (const change of [
    { binding: { kind: 'fixed', theme_id: 'missing:terminal' } },
    { binding: { kind: 'paired', light: 'ade:graphite', dark: 'ade:carbon' } },
    { binding: { kind: 'invalid' } },
    {},
    { binding: null, workspace_id: 'foreign-workspace' },
    { binding: null, terminal_id: 'missing-terminal' },
    { binding: null, expected_appearance_revision: before.revision + 1 },
  ]) {
    expect((await rawReply(profile, { ...base, ...change })).type).toBe('error')
    expect(await profile.call('terminal.appearance.get', target)).toEqual(before)
  }
  const rejected = await profile.cli(
    'terminal',
    'set-appearance',
    workspace.id,
    terminalId,
    String(before.revision),
    JSON.stringify({ kind: 'fixed', theme_id: 'missing:terminal' }),
  )
  expect(rejected.code).not.toBe(0)
  expect(JSON.parse(rejected.stderr)).toMatchObject({ type: 'error' })
  expect(await profile.call('terminal.appearance.get', target)).toEqual(before)
})

test('cursor and selection policies follow the resolved palette into views and recovery', async ({ profile }) => {
  await profile.call('settings.set', { appearance: 'light' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const chalk = {
    cursor_text: { r: 232, g: 235, b: 239 },
    selection_foreground: 'cell-foreground',
    selection_background: { r: 220, g: 232, b: 250 },
  }
  expect((await profile.call('settings.appearance', {})).terminal).toMatchObject(chalk)
  const view = await openView(profile, workspace.id, terminalId)
  try {
    expect(view.frames.find((frame) => frame.type === 'snapshot')).toMatchObject({ appearance: chalk })
    await profile.call('settings.set', { appearance: 'dark' })
    await expect
      .poll(() => [...view.frames].reverse().find((frame) => frame.type === 'terminal_appearance'))
      .toMatchObject({
        appearance: {
          cursor_text: { r: 16, g: 17, b: 19 },
          selection_foreground: 'cell-foreground',
          selection_background: { r: 40, g: 60, b: 85 },
        },
      })
  } finally {
    view.dispose()
  }
  await profile.restartDaemon('kill')
  const recovered = await openView(profile, workspace.id, terminalId)
  try {
    expect(recovered.frames.find((frame) => frame.type === 'snapshot')).toMatchObject({
      appearance: {
        selection_background: { r: 40, g: 60, b: 85 },
        selection_foreground: 'cell-foreground',
      },
    })
  } finally {
    recovered.dispose()
  }
})

test('profile terminal color overrides validate atomically, persist and reset through public operations', async ({
  profile,
}) => {
  const before = await profile.call('settings.get', {})
  const overrides = {
    cursor_text: 'cell-foreground',
    selection_foreground: { r: 12, g: 34, b: 56 },
    selection_background: 'cell-background',
  }
  const saved = await rawReply(profile, {
    op: 'settings.set',
    terminal_color_overrides: overrides,
    expected_appearance_revision: before.settings.appearance_revision,
  })
  expect(saved.type).toBe('settings')
  expect((await profile.call('settings.appearance', {})).terminal).toMatchObject(overrides)
  const revision = (await profile.call('settings.get', {})).settings.appearance_revision
  expect(revision).toBe(before.settings.appearance_revision + 1)
  const committed = (await profile.call('settings.get', {})).settings
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const views = [await openView(profile, workspace.id, terminalId), await openView(profile, workspace.id, terminalId)]
  try {
    for (const view of views)
      expect(view.frames.find((frame) => frame.type === 'snapshot')).toMatchObject({ appearance: overrides })
    views[0]!.viewer.screen.setSelection({ x: 0, y: 0 }, { x: 2, y: 0 })
    expect(views[0]!.viewer.screen.selectionText().length).toBeGreaterThan(0)
    expect(views[1]!.viewer.screen.selectionText()).toBe('')
  } finally {
    for (const view of views) view.dispose()
  }

  await rawReply(profile, {
    op: 'settings.set',
    terminal_color_overrides: overrides,
    expected_appearance_revision: revision,
  })
  expect((await profile.call('settings.get', {})).settings).toEqual(committed)

  for (const invalid of [
    { cursor_text: 'unknown' },
    { cursor_text: { r: 12, g: 34, b: 56, alpha: 0.5 } },
    { selection_foreground: { r: 256, g: 0, b: 0 } },
    { selection_background: { r: 0.5, g: 0, b: 0 } },
    { cursor_text: 'cell-background', other: true },
  ]) {
    expect((await rawReply(profile, { op: 'settings.set', terminal_color_overrides: invalid })).type).toBe('error')
    expect((await profile.call('settings.get', {})).settings.appearance_revision).toBe(revision)
  }
  expect(
    (
      await rawReply(profile, {
        op: 'settings.set',
        terminal_color_overrides: {},
        expected_appearance_revision: revision - 1,
      })
    ).type,
  ).toBe('error')
  await profile.restartDaemon('kill')
  expect((await profile.call('settings.appearance', {})).terminal).toMatchObject(overrides)
  const reset = await profile.cli(
    'settings',
    'set',
    'terminal_color_overrides',
    '{}',
    'expected_appearance_revision',
    String(revision),
  )
  expect(reset.code, reset.stderr).toBe(0)
  expect((await profile.call('settings.appearance', {})).terminal).toMatchObject({
    cursor_text: { r: 16, g: 17, b: 19 },
    selection_foreground: 'cell-foreground',
    selection_background: { r: 40, g: 60, b: 85 },
  })
})

test('terminal contrast is a durable renderer policy and cannot replace source colors', async ({ profile }) => {
  const before = await profile.call('settings.appearance', {})
  expect(before.terminal).toMatchObject({ minimum_contrast: 1 })
  const saved = await rawReply(profile, {
    op: 'settings.set',
    terminal_minimum_contrast: 4.5,
    expected_appearance_revision: before.revision,
  })
  expect(saved.type).toBe('settings')
  const corrected = await profile.call('settings.appearance', {})
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const script = join(profile.root, 'query-contrast.py')
  writeFileSync(script, queryProgram)
  const sent = await profile.cli('terminal', 'send', workspace.id, terminalId, `python3 '${script}'`)
  expect(sent.code, sent.stderr).toBe(0)
  await expect
    .poll(async () =>
      replayText((await profile.cli('terminal', 'inspect', workspace.id, terminalId)).json as TerminalFrame),
    )
    .toContain(Buffer.from('\x1b]10;rgb:ecec/eeee/f2f2').toString('hex'))

  expect(corrected.terminal).toMatchObject({
    minimum_contrast: 4.5,
    foreground: before.terminal.foreground,
    background: before.terminal.background,
    palette: before.terminal.palette,
  })
  const view = await openView(profile, workspace.id, terminalId)
  try {
    expect(view.frames.find((frame) => frame.type === 'snapshot')).toMatchObject({
      appearance: { minimum_contrast: 4.5 },
    })
    expect(view.viewer.screen.snapshot().foreground).toEqual(before.terminal.foreground)
  } finally {
    view.dispose()
  }
  for (const value of [0, 22, '4.5', null]) {
    expect((await rawReply(profile, { op: 'settings.set', terminal_minimum_contrast: value })).type).toBe('error')
    expect((await profile.call('settings.appearance', {})).terminal).toEqual(corrected.terminal)
  }
  await profile.restartDaemon('kill')
  expect((await profile.call('settings.appearance', {})).terminal).toEqual(corrected.terminal)
  const reset = await profile.cli(
    'settings',
    'set',
    'terminal_minimum_contrast',
    '1',
    'expected_appearance_revision',
    String(corrected.revision),
  )
  expect(reset.code, reset.stderr).toBe(0)
  expect((await profile.call('settings.appearance', {})).terminal).toMatchObject({ minimum_contrast: 1 })
})

test('bold color is a revision-checked profile policy shared by terminal bindings and restored on restart', async ({
  profile,
}) => {
  const initial = await profile.call('settings.get', {})
  expect(initial.settings).toMatchObject({ terminal_bold_color: 'inherit' })
  const saved = await profile.cli(
    'settings',
    'set',
    'terminal_bold_color',
    'bright',
    'expected_appearance_revision',
    String(initial.settings.appearance_revision),
  )
  expect(saved.code, saved.stderr).toBe(0)
  const bright = await profile.call('settings.appearance', {})
  expect(bright.terminal).toMatchObject({ bold_color: 'bright' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  await profile.call('terminal.appearance.set', {
    workspace_id: workspace.id,
    terminal_id: terminalId,
    binding: { kind: 'fixed', theme_id: 'ade:chalk' },
    expected_appearance_revision: bright.revision,
  })
  const revision = (await profile.call('settings.get', {})).settings.appearance_revision
  const literal = { r: 17, g: 34, b: 51 }
  const applied = await rawReply(profile, {
    op: 'settings.set',
    terminal_bold_color: literal,
    expected_appearance_revision: revision,
  })
  expect(applied.type).toBe('settings')
  const current = await profile.call('settings.get', {})
  for (const invalid of ['invalid', { r: -1, g: 0, b: 0 }, { r: 1, g: 2, b: 3, alpha: 1 }]) {
    expect((await rawReply(profile, { op: 'settings.set', terminal_bold_color: invalid })).type).toBe('error')
    expect((await profile.call('settings.get', {})).settings).toEqual(current.settings)
  }
  expect(
    (
      await rawReply(profile, {
        op: 'settings.set',
        terminal_bold_color: 'inherit',
        expected_appearance_revision: revision,
      })
    ).type,
  ).toBe('error')
  await profile.restartDaemon('kill')
  expect((await profile.call('settings.get', {})).settings).toEqual(current.settings)
  const views = [await openView(profile, workspace.id, terminalId), await openView(profile, workspace.id, terminalId)]
  try {
    for (const view of views)
      expect(view.frames.find((frame) => frame.type === 'snapshot')).toMatchObject({
        appearance: { bold_color: literal, dark: false },
      })
  } finally {
    for (const view of views) view.dispose()
  }
  await profile.call('settings.appearance.reset', {
    expected_appearance_revision: current.settings.appearance_revision,
  })
  expect((await profile.call('settings.appearance', {})).terminal).toMatchObject({ bold_color: 'inherit' })
})

test('bold policies leave native default and indexed color queries unchanged with two attached views', async ({
  profile,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const source = await profile.call('settings.appearance', {})
  const views = [await openView(profile, workspace.id, terminalId), await openView(profile, workspace.id, terminalId)]
  const oscRgb = ({ r, g, b }: { r: number; g: number; b: number }) =>
    [r, g, b].map((byte) => byte.toString(16).padStart(2, '0').repeat(2)).join('/')
  try {
    for (const [index, policy] of ['bright', { r: 17, g: 34, b: 51 }, 'inherit'].entries()) {
      await rawReply(profile, { op: 'settings.set', terminal_bold_color: policy })
      const marker = `BOLD_${index}:`
      const script = join(profile.root, `query-bold-${index}.py`)
      writeFileSync(
        script,
        queryProgram
          .replace("b'\\x1b]10;?", "b'\\x1b[2J\\x1b[H\\x1b]4;1;?\\x07\\x1b]4;9;?\\x07\\x1b]10;?")
          .replace('APPEARANCE:', marker),
      )
      views[0]!.connection.input(`python3 '${script}'\n`)
      for (const view of views) {
        const screen = await view.until('bold policy preserves native color replies', (state) =>
          state.lines.join('').includes(marker),
        )
        const encoded = screen.lines
          .join('')
          .split(marker)[1]!
          .match(/^[a-f0-9]+/)![0]
        const reply = Buffer.from(encoded, 'hex').toString()
        for (const [query, color] of [
          ['4;1', source.terminal.palette[1]!],
          ['4;9', source.terminal.palette[9]!],
          ['10', source.terminal.foreground],
          ['11', source.terminal.background],
          ['12', typeof source.terminal.cursor === 'string' ? source.terminal.foreground : source.terminal.cursor],
        ] as const) {
          const expected = `\x1b]${query};rgb:${oscRgb(color)}`
          expect(reply).toContain(expected)
          expect(reply.split(expected)).toHaveLength(2)
        }
        expect(view.viewer.screen.snapshot().foreground).toEqual(source.terminal.foreground)
      }
    }
  } finally {
    for (const view of views) view.dispose()
  }
})
