// F081 on the xterm side, headless: a full-screen program keeps running
// while its only view detaches and the daemon is killed, and a new view
// restores the same screen, cursor, alternate buffer and modes in a real
// xterm.js core through the desktop adapter's TerminalFeed. Drawing it on a
// DOM, fit and focus stay with Electron E2E.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, isRunning, test } from '../fixtures'
import { terminalMetrics } from '../fixtures/terminals'
import { openView } from './xterm'

/**
 * A full-screen program: raw mode, alternate screen, bracketed paste,
 * application cursor keys and mouse reporting. It draws a fixed screen,
 * shows each key it reads, and restores everything when it reads `q`.
 */
const fullScreenProgram = String.raw`
import os, termios, tty
saved = termios.tcgetattr(0)
tty.setraw(0)
def out(text):
    os.write(1, text.encode())
out('\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[2J\x1b[H')
out('full-screen-program\x1b[3;5Hwide:中文 é\x1b[4;5Hpid:%d\x1b[5;7H' % os.getpid())
while True:
    data = os.read(0, 64)
    if b'q' in data:
        break
    out('\x1b[8;1Hkey:%s\x1b[K\x1b[5;7H' % data.hex())
out('\x1b[?1000l\x1b[?1l\x1b[?2004l\x1b[?1049l')
termios.tcsetattr(0, termios.TCSADRAIN, saved)
out('program-exit\r\n')
`

test('a full-screen program survives detach and a daemon kill, and xterm restores its screen and modes', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const script = join(profile.root, 'full_screen.py')
  writeFileSync(script, fullScreenProgram)

  const first = await openView(profile, ...target)
  const runId = first.connection.incarnation()
  const before = (await terminalMetrics(profile, ...target))!
  first.connection.input(`python3 '${script}'\n`)
  await first.until('the program to draw', (screen) => screen.buffer === 'alternate' &&
    screen.lines.some((line) => line.trim().startsWith('pid:')))
  first.connection.input('x')
  const drawn = await first.until('the key to show', (screen) => screen.lines[7] === 'key:78')
  const programPid = Number(drawn.lines.find((line) => line.trim().startsWith('pid:'))!.trim().slice(4))
  expect(drawn).toMatchObject({ buffer: 'alternate', cursor: [6, 4],
    modes: { bracketedPasteMode: true, applicationCursorKeysMode: true, mouseTrackingMode: 'vt200' } })
  expect(drawn.lines[0]).toBe('full-screen-program')
  expect(drawn.lines[2]).toBe('    wide:中文 e\u0301')

  // The only view detaches, then the daemon is killed and replaced.
  first.connection.detach()
  first.view.terminal.dispose()
  const hello = await profile.restartDaemon('kill')
  expect(hello.runtime_instance).toBe(profile.hello.runtime_instance)
  expect(await isRunning(programPid)).toBe(true)

  // A new view restores exactly what the old one showed, without restarting anything.
  const second = await openView(profile, ...target)
  expect(second.connection.incarnation()).toBe(runId)
  expect(await second.screen()).toEqual(drawn)
  expect(await terminalMetrics(profile, ...target)).toMatchObject({ run_id: runId, shell_pid: before.shell_pid, shell_running: true })

  // The same program still reads keys, and leaving it restores the shell's screen and modes.
  second.connection.input('y')
  await second.until('the next key', (screen) => screen.lines[7] === 'key:79')
  second.connection.input('q')
  const after = await second.until('the program to exit', (screen) => screen.buffer === 'normal' &&
    screen.lines.some((line) => line === 'program-exit'))
  expect(after.modes).toMatchObject({ bracketedPasteMode: false, applicationCursorKeysMode: false, mouseTrackingMode: 'none' })
  expect(after.lines.join('')).toContain(`python3 '${script}'`)
  await expect.poll(() => isRunning(programPid), { message: 'the program to exit' }).toBe(false)

  // Output arrived in order: a third view built from the replay alone matches the live one.
  const third = await openView(profile, ...target)
  // The shell's prompt may still be arriving; both views then show it.
  await expect.poll(async () => JSON.stringify(await third.screen()) === JSON.stringify(await second.screen()),
    { message: 'the replayed view to match the live one' }).toBe(true)
  expect((await third.screen()).lines).toContain('program-exit')
  second.connection.dispose()
  third.connection.dispose()
})
