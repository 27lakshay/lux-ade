import type { TerminalSnapshotFrame } from '../../../packages/contracts/dist/index.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, primaryShell, test } from '../fixtures'
import { queryProgram } from '../fixtures/appearance'
import { openView } from './viewer'

test('imported extended Ghostty colors agree in native replies and WASM cells after recovery', async ({ profile }) => {
  const report = await profile.call('themes.ghostty.validate', {
    id: 'user:ghostty-native',
    name: 'Ghostty native',
    mode: 'dark',
    source_name: 'native fixture',
    source:
      'foreground = #abcdef\nbackground = #123456\npalette = 16=#fedcba\npalette = 255=#654321\ncursor-color = #789abc\n',
  })
  expect(report.validation.valid).toBe(true)
  await profile.call('themes.install', { items: [{ source: report.source!, expected_revision: 0 }] })
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:ghostty-native' } })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminal = await primaryShell(profile, workspace.id)
  const script = join(profile.root, 'ghostty-query.py')
  await writeFile(
    script,
    queryProgram.replace(String.raw`\x1b[?996n`, String.raw`\x1b]4;16;?\x07\x1b]4;255;?\x07\x1b[?996n`) +
      String.raw`
print('\x1b[38;5;16mA\x1b[38;5;255mB\x1b[0m', flush=True)
`,
  )
  const sent = await profile.cli('terminal', 'send', workspace.id, terminal, `python3 '${script}'`)
  expect(sent.code, sent.stderr).toBe(0)
  const view = await openView(profile, workspace.id, terminal)
  try {
    const state = await view.until('imported color query response', (state) =>
      state.lines.some((line) => line.includes('APPEARANCE:')),
    )
    const reply = Buffer.from(
      state.lines
        .join('')
        .split('APPEARANCE:')[1]!
        .match(/^[a-f0-9]+/)![0],
      'hex',
    ).toString()
    expect(reply).toContain('\x1b]10;rgb:abab/cdcd/efef')
    expect(reply).toContain('\x1b]11;rgb:1212/3434/5656')
    expect(reply).toContain('\x1b]12;rgb:7878/9a9a/bcbc')
    expect(reply).toContain('\x1b]4;16;rgb:fefe/dcdc/baba')
    expect(reply).toContain('\x1b]4;255;rgb:6565/4343/2121')
    await expect
      .poll(() =>
        view.viewer.screen
          .snapshot()
          .rowData.flatMap((row) => row.cells)
          .filter(
            (cell) =>
              (cell.text === 'A' && cell.foreground.r === 254) || (cell.text === 'B' && cell.foreground.r === 101),
          )
          .map((cell) => ({ text: cell.text, color: cell.foreground })),
      )
      .toEqual([
        { text: 'A', color: { r: 254, g: 220, b: 186 } },
        { text: 'B', color: { r: 101, g: 67, b: 33 } },
      ])
  } finally {
    view.dispose()
  }
  const before = (await profile.cli('terminal', 'inspect', workspace.id, terminal))
    .json as unknown as TerminalSnapshotFrame
  await profile.restartDaemon('kill')
  const restored = await openView(profile, workspace.id, terminal)
  try {
    expect(restored.viewer.screen.snapshot()).toMatchObject({
      foreground: { r: 171, g: 205, b: 239 },
      background: { r: 18, g: 52, b: 86 },
    })
    const after = (await profile.cli('terminal', 'inspect', workspace.id, terminal))
      .json as unknown as TerminalSnapshotFrame
    expect(after.run_id).toBe(before.run_id)
    expect(after.metrics.shell_pid).toBe(before.metrics.shell_pid)
  } finally {
    restored.dispose()
  }
})

test('native OSC 12 preserves app overrides across appearance switches and resets to the new symbolic default', async ({
  profile,
}) => {
  const report = await profile.call('themes.ghostty.validate', {
    id: 'user:ghostty-symbolic-cursor',
    name: 'Ghostty symbolic cursor',
    mode: 'dark',
    source_name: 'native cursor fixture',
    source:
      'foreground = #abcdef\nbackground = #123456\npalette = 16=#fedcba\npalette = 255=#654321\ncursor-color = cell-background\n',
  })
  expect(report.validation.valid).toBe(true)
  await profile.call('themes.install', { items: [{ source: report.source!, expected_revision: 0 }] })
  const nextReport = await profile.call('themes.ghostty.validate', {
    id: 'user:ghostty-symbolic-cursor-next',
    name: 'Ghostty symbolic cursor next',
    mode: 'dark',
    source_name: 'next native cursor fixture',
    source:
      'foreground = #0f1e2d\nbackground = #123456\npalette = 16=#fedcba\npalette = 255=#654321\ncursor-color = cell-background\n',
  })
  expect(nextReport.validation.valid).toBe(true)
  await profile.call('themes.install', { items: [{ source: nextReport.source!, expected_revision: 0 }] })
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:ghostty-symbolic-cursor' } })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminal = await primaryShell(profile, workspace.id)
  const script = join(profile.root, 'ghostty-cursor-query.py')
  await writeFile(
    script,
    String.raw`import os, select, termios, tty, time
saved = termios.tcgetattr(0)
tty.setraw(0)
try:
    def query(label, action=None):
        if action:
            os.write(1, action)
        os.write(1, b'\x1b]12;?\x07')
        reply = b''
        deadline = time.monotonic() + 5
        while b'\x07' not in reply:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
                raise RuntimeError('terminal did not answer OSC 12')
            reply += os.read(0, 4096)
        print('\r\n' + label + ':' + reply.hex(), flush=True)
    query('INITIAL')
    query('OVERRIDE', b'\x1b]12;#ff00aa\x07')
    print('\r\nOVERRIDE_READY', flush=True)
    if not select.select([0], [], [], 10)[0]:
        raise RuntimeError('appearance switch did not reach the running process')
    os.read(0, 1)
    query('SWITCHED')
    query('RESET', b'\x1b]112\x07')
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
print('\x1b[38;5;255;48;5;16mZ\x1b[0m', flush=True)
`,
  )
  const sent = await profile.cli('terminal', 'send', workspace.id, terminal, `python3 '${script}'`)
  expect(sent.code, sent.stderr).toBe(0)
  const view = await openView(profile, workspace.id, terminal)
  try {
    const beforeSwitch = await view.until('native OSC12 override before appearance switch', (state) =>
      state.lines.some((line) => line.includes('OVERRIDE_READY')),
    )
    const replyBeforeSwitch = Buffer.from(
      beforeSwitch.lines
        .join('')
        .split('OVERRIDE:')[1]!
        .match(/^[a-f0-9]+/)![0],
      'hex',
    ).toString()
    expect(replyBeforeSwitch).toContain('\x1b]12;rgb:ffff/0000/aaaa')
    await profile.call('settings.set', {
      terminal_binding: { kind: 'fixed', theme_id: 'user:ghostty-symbolic-cursor-next' },
    })
    const switchSent = await profile.cli('terminal', 'send', workspace.id, terminal, 'x')
    expect(switchSent.code, switchSent.stderr).toBe(0)
    const state = await view.until(
      'native cursor query after appearance switch and indexed cell',
      (state) => state.lines.some((line) => line.includes('RESET:')) && state.lines.some((line) => line.includes('Z')),
    )
    const replyFor = (label: string) => {
      const hex = state.lines
        .join('')
        .split(`${label}:`)[1]!
        .match(/^[a-f0-9]+/)![0]
      return Buffer.from(hex, 'hex').toString()
    }
    expect(replyFor('INITIAL')).toContain('\x1b]12;rgb:abab/cdcd/efef')
    expect(replyFor('INITIAL')).not.toContain('rgb:fefe/dcdc/baba')
    expect(replyFor('OVERRIDE')).toContain('\x1b]12;rgb:ffff/0000/aaaa')
    expect(replyFor('SWITCHED')).toContain('\x1b]12;rgb:ffff/0000/aaaa')
    expect(replyFor('RESET')).toContain('\x1b]12;rgb:0f0f/1e1e/2d2d')
    await expect
      .poll(() =>
        view.viewer.screen
          .snapshot()
          .rowData.flatMap((row) => row.cells)
          .filter((cell) => cell.text === 'Z')
          .map((cell) => ({ foreground: cell.foreground, background: cell.background })),
      )
      .toEqual([{ foreground: { r: 101, g: 67, b: 33 }, background: { r: 254, g: 220, b: 186 } }])
  } finally {
    view.dispose()
  }
})
