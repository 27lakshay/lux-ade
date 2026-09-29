// The local CLI's own contract: distinct exit codes for an unavailable socket,
// a non-TTY attach and an incompatible daemon, and a terminal attach that
// keeps the shell running and restores the local TTY when a signal ends it.
// Ported from the legacy e2e/specs/local-cli spec.
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, primaryShell, test } from '../fixtures'
import { binaries } from '../fixtures/environment'

const run = promisify(execFile)

/** Drive `ade terminal attach` on a real PTY, signal it, and report its exit code and TTY state. */
const signalAttachedPty = `import json, os, pty, select, signal, subprocess, sys, termios, time
node, cli, socket, workspace, terminal, signal_name = sys.argv[1:]
master, slave = pty.openpty()
mask = termios.ICANON | termios.ECHO
before = termios.tcgetattr(slave)[3] & mask
child = subprocess.Popen([node, cli, '--socket', socket, 'terminal', 'attach', workspace, terminal],
                         stdin=slave, stdout=slave, stderr=subprocess.PIPE, close_fds=True)
output = bytearray()
try:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and termios.tcgetattr(slave)[3] & mask:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready: output.extend(os.read(master, 65536))
    if termios.tcgetattr(slave)[3] & mask:
        raise RuntimeError('Attach did not enter raw mode: code=' + str(child.poll()) + ' output=' + repr(output[-1000:]))
    os.write(master, b'echo __ADE_SIGNAL_READY__\\n')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and output.count(b'__ADE_SIGNAL_READY__') < 2:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready: output.extend(os.read(master, 65536))
    if output.count(b'__ADE_SIGNAL_READY__') < 2:
        raise RuntimeError('Fresh shell result missing: code=' + str(child.poll()) + ' output=' + repr(output[-1000:]))
    os.kill(child.pid, getattr(signal, signal_name))
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and child.poll() is None:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try: output.extend(os.read(master, 65536))
            except OSError: break
    if child.poll() is None: raise RuntimeError(signal_name + ' did not exit attach')
    child.wait(timeout=1)
    print(json.dumps({'code': child.returncode, 'tty_restored': (termios.tcgetattr(slave)[3] & mask) == before,
                      'stderr': child.stderr.read().decode('utf8', 'replace')}))
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
    os.close(slave)
`

test('CLI distinguishes an unavailable socket from an incompatible daemon protocol', async ({ ade, profile }) => {
  const missing = join(ade.root, 'missing.sock')
  const incompatible = join(ade.root, 'incompatible.sock')
  const unavailable = await profile.cli('--socket', missing, 'status')
  expect(unavailable).toMatchObject({ code: 3, json: { type: 'error', code: 'unavailable' } })
  const nonTty = await profile.cli('--socket', missing, 'terminal', 'attach', 'workspace', 'terminal')
  expect(nonTty).toMatchObject({ code: 2, json: { type: 'error', code: 'usage' } })
  expect(String(nonTty.json!.message)).toContain('requires a TTY')

  // A peer that answers hello with a future protocol is incompatible, not unavailable.
  const server = createServer((peer) => {
    peer.once('data', () =>
      peer.write('{"type":"hello","application_protocol":"future-v2","session_protocol":"ade-sessions-v1"}\n'),
    )
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(incompatible, resolveListen)
  })
  try {
    const mismatch = await profile.cli('--socket', incompatible, 'status')
    expect(mismatch).toMatchObject({ code: 4, json: { type: 'error', code: 'incompatible' } })
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
})

test('terminal attach preserves signal exit status and restores the local TTY', async ({ profile }) => {
  const workspace = (await profile.call('catalog.get', {})).catalog.workspaces[0]!
  const terminalId = await primaryShell(profile, workspace.id)
  const inspect = async () =>
    (await profile.cli('terminal', 'inspect', workspace.id, terminalId)).json!.metrics as {
      shell_pid: number
      shell_running: boolean
    }
  const shellPid = (await inspect()).shell_pid
  for (const [signalName, exitCode] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const) {
    const result = await run(
      'python3',
      ['-c', signalAttachedPty, process.execPath, binaries.cli, profile.socket, workspace.id, terminalId, signalName],
      { timeout: 12_000, env: profile.env },
    )
    expect(JSON.parse(result.stdout)).toMatchObject({ code: exitCode, tty_restored: true, stderr: '' })
  }
  // Ending the attach never ends the shell.
  expect(await inspect()).toMatchObject({ shell_pid: shellPid, shell_running: true })
})
