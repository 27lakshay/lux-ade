import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')
const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string

const attachThroughPty = `import fcntl, hashlib, json, os, pty, select, signal, struct, subprocess, sys, termios, time
node, cli, socket, workspace, terminal = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
tty_flags = termios.ICANON | termios.ECHO
before_flags = termios.tcgetattr(slave)[3] & tty_flags
child = subprocess.Popen([node, cli, '--socket', socket, 'terminal', 'attach', workspace, terminal],
                         stdin=slave, stdout=slave, stderr=subprocess.PIPE, close_fds=True)
output = bytearray()
deadline = time.monotonic() + 16
ready_at = None
output_at = None
last_probe = 0
paste_command_at = None
paste_command_sent = False
paste_sent = False
hash_at = None
payload = (b'ABCDEFGHIJKLMNOPQRSTUVWXYZ' * 3000)[:70000]
expected_hash = hashlib.sha256(payload).hexdigest().encode()
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try: output.extend(os.read(master, 65536))
            except OSError: break
        if ready_at is None and b'__ADE_CLI_SHARED_TERMINAL__' in output:
            ready_at = time.monotonic()
        if ready_at is not None and time.monotonic() - ready_at > 0.5 and time.monotonic() - last_probe > 0.5 and b'29 91' not in output:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 29, 91, 0, 0))
            os.kill(child.pid, signal.SIGWINCH)
            os.write(master, b'stty size; echo __ADE_ATTACH_OUTPUT__\\n')
            last_probe = time.monotonic()
        if output_at is None and b'__ADE_ATTACH_OUTPUT__' in output and b'29 91' in output:
            output_at = time.monotonic()
        if not paste_command_sent and output_at is not None and time.monotonic() - output_at > 0.2:
            os.write(master, b"stty -echo -icanon min 1 time 0; echo __ADE_PASTE_READY__; python3 -c 'import sys,hashlib; d=sys.stdin.buffer.read(70000); print(hashlib.sha256(d).hexdigest())'; stty sane\\n")
            paste_command_sent = True
        if paste_command_at is None and b'__ADE_PASTE_READY__' in output:
            paste_command_at = time.monotonic()
        if not paste_sent and paste_command_at is not None and time.monotonic() - paste_command_at > 0.3:
            cursor = 0
            while cursor < len(payload): cursor += os.write(master, payload[cursor:])
            paste_sent = True
        if hash_at is None and paste_sent and expected_hash in output:
            hash_at = time.monotonic()
        if hash_at is not None and time.monotonic() - hash_at > 0.2:
            os.write(master, b'\\x1d')
            break
    try: child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        print(json.dumps({'code': 'timeout', 'output': output.decode('utf8', 'replace')}))
        raise
    print(json.dumps({'code': child.returncode, 'output': output.decode('utf8', 'replace'),
                      'stderr': child.stderr.read().decode('utf8', 'replace'),
                      'expected_hash': expected_hash.decode(),
                      'tty_restored': (termios.tcgetattr(slave)[3] & tty_flags) == before_flags}))
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
    os.close(slave)
`

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

async function runCli(socket: string, ...args: string[]): Promise<{ code: number; output: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, '--socket', socket, ...args], { timeout: 12_000 })
    return { code: 0, output: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, output: JSON.parse(failure.stderr) as Record<string, unknown> }
  }
}

test('CLI and Electron control one runtime-owned workspace terminal', async () => {
  const daemon = await startDaemon()
  const userData = await mkdtemp(join(tmpdir(), 'ade-cli-electron-e2e-'))
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData },
  })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    await expect(window.locator('.terminal-surface .xterm-rows')).toBeVisible()
    const catalogue = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalogue.catalog as {
      workspaces: Array<{ id: string; terminal_id: string }>
    }).workspaces[0]
    const listed = await runCli(daemon.socket, 'workspace', 'list')
    expect(listed.code).toBe(0)
    expect(listed.output.workspaces).toEqual(expect.arrayContaining([expect.objectContaining({ id: workspace.id })]))

    const inspected = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    expect(inspected.code).toBe(0)
    expect(inspected.output.type).toBe('snapshot')
    expect((inspected.output.metrics as { terminal_id: string }).terminal_id).toBe(workspace.terminal_id)
    const shellPid = (inspected.output.metrics as { shell_pid: number }).shell_pid

    const sent = await runCli(daemon.socket, 'terminal', 'send', workspace.id, workspace.terminal_id, 'echo __ADE_CLI_SHARED_TERMINAL__')
    expect(sent.code).toBe(0)
    expect(sent.output.type).toBe('terminal_input_submitted')
    expect((sent.output.metrics as { shell_pid: number }).shell_pid).toBe(shellPid)
    await expect.poll(async () => {
      const snapshot = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
      const events = (snapshot.output.terminal_recovery as { events: Array<{ type: string; bytes_base64?: string }> }).events
      return events.filter((event) => event.type === 'output' && event.bytes_base64)
        .map((event) => Buffer.from(event.bytes_base64!, 'base64').toString('utf8')).join('')
    }).toContain('__ADE_CLI_SHARED_TERMINAL__')
    await window.locator('.terminal-surface').scrollIntoViewIfNeeded()
    await expect(window.locator('.terminal-surface .xterm-rows')).toContainText('__ADE_CLI_SHARED_TERMINAL__')

    const resized = await runCli(daemon.socket, 'terminal', 'resize', workspace.id, workspace.terminal_id, '90', '31')
    expect(resized.code).toBe(0)
    expect(resized.output).toMatchObject({ type: 'terminal_resize_submitted', cols: 90, rows: 31 })
    const after = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    expect(after.code).toBe(0)
    const recovery = after.output.terminal_recovery as { events: Array<Record<string, unknown>> }
    expect(recovery.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'resize', cols: 90, rows: 31 })]))
    const runtime = await rpc(daemon.socket, { op: 'runtime.status' })
    const terminals = runtime.terminals as Array<{ metrics: { shell_pid: number; terminal_id: string } }>
    expect(terminals.find((item) => item.metrics.terminal_id === workspace.terminal_id)?.metrics.shell_pid).toBe(shellPid)

    const attached = await execFileAsync('python3', ['-c', attachThroughPty, process.execPath, cli,
      daemon.socket, workspace.id, workspace.terminal_id], { timeout: 20_000 }).catch((error: Error & { stdout?: string }) => {
      throw new Error(`${error.message}\nPTY output: ${error.stdout ?? ''}`)
    })
    const attachment = JSON.parse(attached.stdout) as { code: number; output: string; stderr: string;
      expected_hash: string; tty_restored: boolean }
    expect(attachment, attachment.output).toMatchObject({ code: 0, stderr: '', tty_restored: true })
    expect(attachment.output).toContain('__ADE_ATTACH_OUTPUT__')
    expect(attachment.output).toContain('29 91')
    expect(attachment.output).toContain(attachment.expected_hash)
    const afterDetach = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    expect((afterDetach.output.metrics as { shell_pid: number; shell_running: boolean }))
      .toMatchObject({ shell_pid: shellPid, shell_running: true })
  } finally {
    await application.close()
    await daemon.stop()
    await rm(userData, { recursive: true, force: true })
  }
})

test('CLI distinguishes an unavailable socket from an incompatible daemon protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-cli-endpoint-e2e-'))
  const missing = join(directory, 'missing.sock')
  const incompatible = join(directory, 'incompatible.sock')
  const unavailable = await runCli(missing, 'status')
  expect(unavailable).toMatchObject({ code: 3, output: { type: 'error', code: 'unavailable' } })
  const nonTty = await runCli(missing, 'terminal', 'attach', 'workspace', 'terminal')
  expect(nonTty).toMatchObject({ code: 2, output: { type: 'error', code: 'usage' } })
  expect(String(nonTty.output.message)).toContain('requires a TTY')

  const server = createServer((peer) => {
    peer.once('data', () => peer.write('{"type":"hello","application_protocol":"future-v2","session_protocol":"ade-sessions-v1"}\n'))
  })
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(incompatible, resolveListen)
    })
    const mismatch = await runCli(incompatible, 'status')
    expect(mismatch).toMatchObject({ code: 4, output: { type: 'error', code: 'incompatible' } })
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('terminal attach preserves signal exit status and restores the local TTY', async () => {
  const daemon = await startDaemon()
  try {
    const catalogue = await rpc(daemon.socket, { op: 'catalog.get' })
    const workspace = (catalogue.catalog as { workspaces: Array<{ id: string; terminal_id: string }> }).workspaces[0]
    const before = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    const shellPid = (before.output.metrics as { shell_pid: number }).shell_pid
    for (const [signalName, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
      const result = await execFileAsync('python3', ['-c', signalAttachedPty, process.execPath, cli,
        daemon.socket, workspace.id, workspace.terminal_id, signalName], { timeout: 12_000 })
      expect(JSON.parse(result.stdout)).toMatchObject({ code: exitCode, tty_restored: true, stderr: '' })
    }
    const after = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    expect((after.output.metrics as { shell_pid: number; shell_running: boolean }))
      .toMatchObject({ shell_pid: shellPid, shell_running: true })
  } finally {
    await daemon.stop()
  }
})

test('CLI exposes managed account metadata and requires explicit account selection', async () => {
  const daemon = await startDaemon({ ADE_CLAUDE_BIN: join(tmpdir(), 'ade-missing-claude-cli') })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const created = await runCli(daemon.socket, 'account', 'create', 'claude', 'Work Claude')
    expect(created).toMatchObject({ code: 0, output: { type: 'ack' } })
    const account = created.output.account as { id: string; generation: number; state: string; native_home: string }
    expect(account).toMatchObject({ generation: 0, state: 'unverified' })
    expect(account.native_home).toContain(daemon.dataDirectory)

    const listed = await runCli(daemon.socket, 'account', 'list')
    expect(listed.code).toBe(0)
    expect(listed.output.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ id: account.id })]))
    const inspection = await runCli(daemon.socket, 'account', 'inspect', account.id)
    expect(inspection).toMatchObject({ code: 0, output: { type: 'account_inspection',
      inspection: { state: 'missing_executable' } } })
    const verification = await runCli(daemon.socket, 'account', 'verify', account.id, '0',
      JSON.stringify({ auth_method: 'claude.ai', api_provider: 'firstParty', email: 'missing@example.invalid', org_id: 'missing' }))
    expect(verification).toMatchObject({ code: 7, output: { type: 'error', code: 'daemon' } })
    expect(String(verification.output.message)).toMatch(/not ready/)

    const ambiguous = await runCli(daemon.socket, 'conversation', 'create', workspace.id,
      'claude', account.id)
    expect(ambiguous).toMatchObject({ code: 2, output: { type: 'error', code: 'usage' } })
    const conversation = await runCli(daemon.socket, 'conversation', 'create', workspace.id,
      'claude', 'Managed', '--account', account.id)
    expect(conversation.code).toBe(0)
    expect(conversation.output.conversation).toMatchObject({ account_id: account.id,
      account_context: 'managed' })
    const disabled = await runCli(daemon.socket, 'account', 'disable', account.id)
    expect(disabled.output.account).toMatchObject({ id: account.id, generation: 1, state: 'disabled' })
    expect(disabled.output.native_logout).toBe(false)
    expect((await runCli(daemon.socket, 'account', 'verify', account.id, 'bad', '{}')).output)
      .toMatchObject({ type: 'error', code: 'usage' })
  } finally {
    await daemon.stop()
  }
})

test('CLI verifies and sends through a managed Claude account using an external provider fixture', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-cli-account-provider-'))
  const nativeCli = join(fixtures, 'claude')
  const bridge = join(fixtures, 'bridge.mjs')
  await writeFile(nativeCli, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') process.stdout.write('2.1.283 (Claude Code)\\n');
else if (process.argv[2] === '--setting-sources' && process.argv[3] === ''
  && process.argv.at(-2) === 'auth' && process.argv.at(-1) === 'status') {
  const home = process.env.CLAUDE_CONFIG_DIR;
  const identity = JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8'));
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    configDirectory: home, email: identity.email, orgId: identity.orgId }) + '\\n');
} else process.exit(2);
`)
  await chmod(nativeCli, 0o700)
  await writeFile(bridge, `#!/usr/bin/env node
import { join } from 'node:path';
import { serve } from ${JSON.stringify(pathToFileURL(resolve('providers/claude/bridge.mjs')).href)};
import { fakeSdk } from ${JSON.stringify(pathToFileURL(resolve('providers/claude/fake-sdk.mjs')).href)};
serve(fakeSdk(join(process.env.CLAUDE_CONFIG_DIR, 'sessions')));
`)
  await chmod(bridge, 0o700)
  const daemon = await startDaemon({ ADE_CLAUDE_BIN: nativeCli, ADE_CLAUDE_BRIDGE_BIN: bridge,
    ANTHROPIC_API_KEY: 'ambient-credential-must-not-be-used' })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory }))
      .workspace as { id: string }
    const created = await runCli(daemon.socket, 'account', 'create', 'claude', 'Fixture account')
    const account = created.output.account as { id: string; native_home: string; generation: number }
    await writeFile(join(account.native_home, 'identity.json'), JSON.stringify({ email: 'cli@example.invalid', orgId: 'org-cli' }))
    const inspection = (await runCli(daemon.socket, 'account', 'inspect', account.id)).output.inspection as
      { state: string; identity: Record<string, unknown> }
    expect(inspection)
      .toMatchObject({ state: 'ready', identity: { email: 'cli@example.invalid' } })
    const wrongIdentity = await runCli(daemon.socket, 'account', 'verify', account.id, '0',
      JSON.stringify({ ...inspection.identity, email: 'changed@example.invalid' }))
    expect(wrongIdentity).toMatchObject({ code: 7, output: { type: 'error', code: 'daemon' } })
    const verified = await runCli(daemon.socket, 'account', 'verify', account.id, '0', JSON.stringify(inspection.identity))
    expect(verified.output.account).toMatchObject({ state: 'verified',
      claude_identity: { email: 'cli@example.invalid', org_id: 'org-cli' } })
    const createdConversation = await runCli(daemon.socket, 'conversation', 'create', workspace.id,
      'claude', 'CLI fixture', '--account', account.id)
    const conversation = createdConversation.output.conversation as { id: string }
    const send = await runCli(daemon.socket, 'conversation', 'send', conversation.id, 'hello from CLI')
    expect(send).toMatchObject({ code: 0, output: { request_id: expect.any(String) } })
    await expect.poll(async () => (await runCli(daemon.socket, 'conversation', 'inspect', conversation.id))
      .output.conversation).toMatchObject({ status: 'ready', account_id: account.id })
    const calls = await readFile(join(account.native_home, 'sessions', 'calls.jsonl'), 'utf8')
    expect(calls).toContain('hello from CLI')
  } finally {
    await daemon.stop()
    await rm(fixtures, { recursive: true, force: true })
  }
})
