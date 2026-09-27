// F082 and D06, the parts a headless xterm.js core can prove: Unicode text
// reaches xterm byte for byte and lands in the cells the runtime's terminal
// uses; control keys reach the foreground program and leave the shell alone;
// and xterm never answers a terminal query that the runtime already
// answered. Fit, search, links, selection and copy, key mapping, IME, themes
// and renderer fallback need a DOM and stay with Electron E2E.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { replayText, terminalMetrics, TerminalStream } from '../fixtures/terminals'
import { newXterm, openView, TerminalFeed } from './xterm'

/** The runtime terminal's cursor column, from its libghostty-vt screen snapshot. */
async function runtimeCursor(
  profile: Parameters<typeof TerminalStream.open>[0],
  workspaceId: string,
  terminalId: string,
): Promise<number> {
  const stream = TerminalStream.open(profile, workspaceId, terminalId, { op: 'subscribe' })
  const snapshot = await stream.snapshot()
  stream.close()
  return (snapshot.terminal_recovery as { cursor_col: number }).cursor_col
}

/**
 * Prints `label:text|` and then waits in `cat`, so no prompt follows and the
 * cursor stays just after the bar until the test sends Ctrl-D.
 */
const unicodeLine = (label: string, text: string): string => `clear; printf '${label}:%s|' '${text}'; cat\n`

test("Unicode reaches xterm byte for byte and CJK and combining text take the runtime's cells", async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const view = await openView(profile, ...target)
  const runId = view.connection.incarnation()
  const shellPid = (await terminalMetrics(profile, ...target))!.shell_pid

  // CJK is two cells wide; e + U+0301 is one cell. The cursor waits just
  // after the bar, so xterm and the runtime must agree on its column.
  const cases = [
    ['cjk', '中文'],
    ['combining', 'é'],
  ] as const
  for (const [label, text] of cases) {
    view.connection.input(unicodeLine(label, text))
    const screen = await view.until(`the ${label} line`, (state) =>
      state.lines.some((line) => line.includes(`${label}:${text}|`)),
    )
    const row = screen.lines.findIndex((line) => line.includes(`${label}:${text}|`))
    const lineText = screen.lines[row]
    const xtermColumn = screen.cursor[1] === row ? screen.cursor[0] : -1
    expect(xtermColumn, `${label}: the cursor stays after the bar`).toBeGreaterThan(0)
    expect(await runtimeCursor(profile, ...target), `${label}: runtime and xterm cursor columns`).toBe(xtermColumn)
    expect(lineText).toContain(`${label}:${text}|`)
    view.connection.binary([4])
  }
  // The replay carries the same UTF-8 bytes the shell wrote.
  const replay = TerminalStream.open(profile, ...target)
  const text = replayText(await replay.snapshot())
  replay.close()
  for (const [label, value] of cases) expect(text).toContain(`${label}:${value}|`)

  // A control key reaches the foreground program, not the shell.
  view.connection.input('sleep 600\n')
  await expect.poll(async () => (await terminalMetrics(profile, ...target))!.shell_running).toBe(true)
  view.connection.binary([3])
  view.connection.input('echo "still-$$"\n')
  await view.until('the shell to answer after Ctrl-C', (state) =>
    state.lines.some((line) => line === `still-${shellPid}`),
  )
  expect(await terminalMetrics(profile, ...target)).toMatchObject({
    run_id: runId,
    shell_pid: shellPid,
    shell_running: true,
  })
  view.connection.dispose()
})

test('an emoji takes the same cells in xterm as in the runtime terminal', async ({ profile }) => {
  // xterm's default Unicode 6 widths count U+1F600 as one cell; the
  // runtime's terminal counts two. The adapter activates Unicode 11 widths.
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const view = await openView(profile, ...target)
  view.connection.input(unicodeLine('emoji', '😀'))
  const screen = await view.until('the emoji line', (state) => state.lines.some((line) => line.includes('emoji:😀|')))
  expect(await runtimeCursor(profile, ...target)).toBe(screen.cursor[0])
  view.connection.binary([4])
  view.connection.dispose()
})

/**
 * A program that asks the terminal for the cursor position (DSR 6) and its
 * device attributes (DA1), prints the answers it read, and then prints
 * whatever else reached it before `q`.
 */
const queryProgram = String.raw`
import os, termios, tty
saved = termios.tcgetattr(0)
tty.setraw(0)
os.write(1, b'\x1b[6n\x1b[c')
answers = b''
while not (b'R' in answers and answers.endswith(b'c')):
    answers += os.read(0, 64)
os.write(1, ('answers:%s\r\n' % answers.hex()).encode())
rest = b''
while b'q' not in rest:
    rest += os.read(0, 64)
os.write(1, ('before-q:[%s]\r\n' % rest[:rest.index(b'q')].hex()).encode())
termios.tcsetattr(0, termios.TCSADRAIN, saved)
`

test('xterm does not answer a terminal query the runtime already answered (D06)', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const target = [workspace.id, workspace.terminal_id] as const
  const script = join(profile.root, 'query.py')
  writeFileSync(script, queryProgram)
  const view = await openView(profile, ...target)
  view.connection.input(`python3 '${script}'\n`)

  // The runtime answered each query once, while the view was attached and
  // parsing the same queries live.
  const answered = await view.until('the program to read its answers', (state) =>
    state.lines.some((line) => line.startsWith('answers:')),
  )
  const answers = Buffer.from(answered.lines.find((line) => line.startsWith('answers:'))!.slice(8), 'hex').toString(
    'latin1',
  )
  expect(answers).toMatch(/^\x1b\[\d+;\d+R\x1b\[\?[\d;]+c$/)

  // Anything xterm sent in reply was written to the socket before the
  // answers were drawn, so it would reach the program before this q.
  view.connection.input('q')
  await view.until('the program to report what else it read', (state) =>
    state.lines.some((line) => line === 'before-q:[]'),
  )

  // Without the adapter's reply suppression, the same frames make xterm answer.
  const bare = newXterm({ prepared: false })
  const replies: string[] = []
  bare.onData((data) => replies.push(data))
  const feed = new TerminalFeed(bare, { status: () => {}, ready: () => {}, failed: () => {} })
  for (const frame of view.frames) feed.push(frame)
  await expect.poll(() => replies.join(''), { message: 'an unsuppressed xterm to answer' }).toMatch(/\x1b\[\d+;\d+R/)
  bare.dispose()
  view.connection.dispose()
})
