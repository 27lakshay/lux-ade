import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, primaryShell, test } from '../fixtures'
import { clientSdk, TerminalStream } from '../fixtures/terminals'
import { rawReply } from '../fixtures/raw-reply'
import { newViewer, openView } from './viewer'

const program = String.raw`
import os, select, termios, time, tty
saved = termios.tcgetattr(0)
tty.setraw(0)
def report(label):
    os.write(1, b'\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07\x1b]4;200;?\x07\x1b[?996n')
    reply = b''
    deadline = time.monotonic() + 5
    while b'\x1b[?997;' not in reply or not reply.endswith(b'n'):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError('missing appearance reply')
        reply += os.read(0, 4096)
    os.write(1, ('\r\nREPORT_' + label + ':' + reply.hex() + '\r\n').encode())
try:
    os.write(1, b'\x1b]10;#123456\x07\x1b]11;#234567\x07\x1b]12;#345678\x07\x1b]4;200;#a1b2c3\x07')
    os.write(1, b'\x1b[2J\x1b[HINDEX:\x1b[38;5;200mX\x1b[0m\r\nRGB:\x1b[38;2;17;34;51mX\x1b[0m\r\nRECOVERY_READY\r\n')
    while True:
        if not select.select([0], [], [], 30)[0]:
            raise RuntimeError('missing recovery input')
        key = os.read(0, 1)
        if key == b'r':
            os.write(1, b'\x1b]110\x07\x1b]111\x07\x1b]112\x07\x1b]104;200\x07')
            report('RESET')
            break
        report('RECOVERED')
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
`

function appearance(view: Awaited<ReturnType<typeof openView>>) {
  const screen = view.viewer.screen.snapshot()
  const cell = (label: string) => screen.rowData.find((row) => row.text.startsWith(label))!.cells[label.length]!
  return {
    foreground: screen.foreground,
    background: screen.background,
    cursor: screen.cursor,
    indexed: cell('INDEX:').foreground,
    rgb: cell('RGB:').foreground,
  }
}

const overrides = {
  foreground: { r: 18, g: 52, b: 86 },
  background: { r: 35, g: 69, b: 103 },
  cursor: { r: 52, g: 86, b: 120 },
  indexed: { r: 161, g: 178, b: 195 },
  rgb: { r: 17, g: 34, b: 51 },
}

test('two views retain all color overrides through daemon replacement and reset to the newest defaults', async ({
  profile,
}) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  let first = await openView(profile, workspace.id, terminalId)
  let second: typeof first | undefined
  try {
    const script = join(profile.root, 'appearance-recovery.py')
    writeFileSync(script, program)
    first.connection.input(`python3 '${script}'\n`)
    await first.until('program installs every override', (state) => state.lines.includes('RECOVERY_READY'))
    second = await openView(profile, workspace.id, terminalId)
    expect(appearance(first)).toEqual(overrides)
    expect(appearance(second)).toEqual(overrides)
    const before = await profile.call('runtime.status', {})
    await profile.call('settings.set', { appearance: 'light' })
    await expect.poll(() => first.frames.some((frame) => frame.type === 'terminal_appearance')).toBe(true)
    expect(appearance(first)).toEqual(overrides)
    expect(appearance(second)).toEqual(overrides)
    first.dispose()
    await profile.restartDaemon('kill')
    second.dispose()
    first = await openView(profile, workspace.id, terminalId)
    second = await openView(profile, workspace.id, terminalId)
    const after = await profile.call('runtime.status', {})
    expect(after.runtime_instance).toBe(before.runtime_instance)
    expect(after.terminals).toMatchObject(
      (before.terminals as Array<{ metrics: { run_id: string; pid: number; terminal_bytes: number } }>).map(
        ({ metrics }) => ({
          metrics: { run_id: metrics.run_id, pid: metrics.pid, terminal_bytes: metrics.terminal_bytes },
        }),
      ),
    )
    expect(appearance(first)).toEqual(overrides)
    expect(appearance(second)).toEqual(overrides)
    first.connection.input('q')
    const observed = await first.until('the same program queries recovered appearance', (state) =>
      state.lines.some((line) => line.startsWith('REPORT_RECOVERED:')),
    )
    const reply = Buffer.from(
      observed.lines
        .join('')
        .split('REPORT_RECOVERED:')[1]!
        .match(/^[a-f0-9]+/)![0],
      'hex',
    ).toString()
    expect(reply).toContain('\x1b]10;rgb:1212/3434/5656')
    expect(reply).toContain('\x1b]11;rgb:2323/4545/6767')
    expect(reply).toContain('\x1b]12;rgb:3434/5656/7878')
    expect(reply).toContain('\x1b]4;200;rgb:a1a1/b2b2/c3c3')
    expect(reply).toContain('\x1b[?997;2n')
    first.connection.input('r')
    await first.until('program resets to the newest theme defaults', (state) =>
      state.lines.some((line) => line.startsWith('REPORT_RESET:')),
    )
    const reset = {
      foreground: { r: 32, g: 36, b: 43 },
      background: { r: 232, g: 235, b: 239 },
      cursor: { r: 32, g: 36, b: 43 },
      indexed: { r: 255, g: 0, b: 215 },
      rgb: overrides.rgb,
    }
    await expect.poll(() => appearance(first)).toEqual(reset)
    await expect.poll(() => appearance(second!)).toEqual(reset)
  } finally {
    first.dispose()
    second?.dispose()
  }
})

test('delayed appearance frames cannot replace a newer snapshot and stale recovery fails visibly', async ({
  profile,
}) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const first = await openView(profile, workspace.id, terminalId)
  const replay = await newViewer()
  const { decodeTerminalFrame } = await clientSdk()
  let latest: typeof first | undefined
  try {
    const oldSnapshot = first.frames.find((frame) => frame.type === 'snapshot')!
    await profile.call('settings.set', { appearance: 'light' })
    await expect.poll(() => first.frames.some((frame) => frame.type === 'terminal_appearance')).toBe(true)
    const oldAppearance = first.frames.find((frame) => frame.type === 'terminal_appearance')!
    await profile.call('settings.set', { appearance: 'dark' })
    latest = await openView(profile, workspace.id, terminalId)
    const newSnapshot = latest.frames.find((frame) => frame.type === 'snapshot')!
    // Deliver the older event before initialization, then restore the latest real attachment.
    replay.feed.push(decodeTerminalFrame(oldAppearance))
    replay.feed.push(decodeTerminalFrame(newSnapshot))
    expect(replay.feed.ready).toBe(true)
    expect(replay.screen.snapshot().background).toEqual({ r: 16, g: 17, b: 19 })
    replay.feed.push(decodeTerminalFrame(oldAppearance))
    expect(replay.screen.snapshot().background).toEqual({ r: 16, g: 17, b: 19 })
    expect(replay.failed()).toBe(false)
    // An older snapshot may contain obsolete program overrides as well as defaults: reject it.
    replay.feed.push(decodeTerminalFrame({ ...oldSnapshot, resync: true }))
    expect(replay.failed()).toBe(true)
    expect(replay.feed.ready).toBe(false)
    expect(replay.statuses).toContain('Terminal snapshot has an older appearance; reconnect to restore it.')
    expect(replay.screen.snapshot().background).toEqual({ r: 16, g: 17, b: 19 })
  } finally {
    first.dispose()
    latest?.dispose()
    replay.feed.dispose()
    replay.screen.dispose()
  }
})

test('an attachment excluding terminal state receives no terminal appearance frames', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const stream = TerminalStream.open(profile, workspace.id, terminalId, { op: 'subscribe', terminal: false })
  try {
    expect(await stream.snapshot()).not.toHaveProperty('appearance')
    await profile.call('settings.set', { appearance: 'light' })
    // Ping is processed after the appearance command, on the same terminal host. Its response
    // drains every earlier queued event, so the negative assertion needs no arbitrary sleep.
    stream.send({ op: 'ping' })
    await stream.waitFor('the terminal host barrier', (frame) => frame.type === 'metrics')
    expect(stream.frames.filter((frame) => frame.type === 'terminal_appearance')).toEqual([])
  } finally {
    stream.close()
  }
})

test('concurrent selections and a new attachment converge on the winning revision', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const first = await openView(profile, workspace.id, terminalId)
  let second: typeof first | undefined
  try {
    const [dark, light, attached] = await Promise.all([
      rawReply(profile, { op: 'settings.set', appearance: 'dark', expected_appearance_revision: 0 }),
      rawReply(profile, { op: 'settings.set', appearance: 'light', expected_appearance_revision: 0 }),
      openView(profile, workspace.id, terminalId),
    ])
    second = attached
    const replies = [dark, light]
    expect(replies.filter((reply) => reply.type === 'settings')).toHaveLength(1)
    expect(replies.filter((reply) => reply.type === 'error')).toEqual([
      expect.objectContaining({ code: 'appearance_conflict', expected: 0, current: 1 }),
    ])
    const committed = await profile.call('settings.appearance', {})
    expect(committed.revision).toBe(1)
    expect(committed.propagation).toEqual({ state: 'applied', revision: 1 })
    for (const view of [first, second]) {
      await expect.poll(() => view.viewer.screen.snapshot().background).toEqual(committed.terminal.background)
      await expect
        .poll(() =>
          view.frames.some((frame) => {
            const appearance = frame.appearance as { revision?: number } | undefined
            return appearance?.revision === committed.revision
          }),
        )
        .toBe(true)
      expect(view.viewer.failed()).toBe(false)
      expect(view.viewer.statuses).toEqual([])
    }
  } finally {
    first.dispose()
    second?.dispose()
  }
})
