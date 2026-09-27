import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

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
    peer.once('data', () =>
      peer.write('{"type":"hello","application_protocol":"future-v2","session_protocol":"ade-sessions-v1"}\n'),
    )
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
    for (const [signalName, exitCode] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
    ] as const) {
      const result = await execFileAsync(
        'python3',
        [
          '-c',
          signalAttachedPty,
          process.execPath,
          cli,
          daemon.socket,
          workspace.id,
          workspace.terminal_id,
          signalName,
        ],
        { timeout: 12_000 },
      )
      expect(JSON.parse(result.stdout)).toMatchObject({ code: exitCode, tty_restored: true, stderr: '' })
    }
    const after = await runCli(daemon.socket, 'terminal', 'inspect', workspace.id, workspace.terminal_id)
    expect(after.output.metrics as { shell_pid: number; shell_running: boolean }).toMatchObject({
      shell_pid: shellPid,
      shell_running: true,
    })
  } finally {
    await daemon.stop()
  }
})

test('CLI exposes managed account metadata and requires explicit account selection', async () => {
  const daemon = await startDaemon({ ADE_CLAUDE_BIN: join(tmpdir(), 'ade-missing-claude-cli') })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as {
      id: string
    }
    const created = await runCli(daemon.socket, 'account', 'create', 'claude', 'Work Claude')
    expect(created).toMatchObject({ code: 0, output: { type: 'ack' } })
    const account = created.output.account as { id: string; generation: number; state: string; native_home: string }
    expect(account).toMatchObject({ generation: 0, state: 'unverified' })
    expect(account.native_home).toContain(daemon.dataDirectory)

    const listed = await runCli(daemon.socket, 'account', 'list')
    expect(listed.code).toBe(0)
    expect(listed.output.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ id: account.id })]))
    const inspection = await runCli(daemon.socket, 'account', 'inspect', account.id)
    expect(inspection).toMatchObject({
      code: 0,
      output: { type: 'account_inspection', inspection: { state: 'missing_executable' } },
    })
    const verification = await runCli(
      daemon.socket,
      'account',
      'verify',
      account.id,
      '0',
      JSON.stringify({
        auth_method: 'claude.ai',
        api_provider: 'firstParty',
        email: 'missing@example.invalid',
        org_id: 'missing',
      }),
    )
    expect(verification).toMatchObject({ code: 7, output: { type: 'error', code: 'daemon' } })
    expect(String(verification.output.message)).toMatch(/not ready/)

    const ambiguous = await runCli(daemon.socket, 'conversation', 'create', workspace.id, 'claude', account.id)
    expect(ambiguous).toMatchObject({ code: 2, output: { type: 'error', code: 'usage' } })
    const conversation = await runCli(
      daemon.socket,
      'conversation',
      'create',
      workspace.id,
      'claude',
      'Managed',
      '--account',
      account.id,
    )
    expect(conversation.code).toBe(0)
    expect(conversation.output.conversation).toMatchObject({ account_id: account.id, account_context: 'managed' })
    const disabled = await runCli(daemon.socket, 'account', 'disable', account.id)
    expect(disabled.output.account).toMatchObject({ id: account.id, generation: 1, state: 'disabled' })
    expect(disabled.output.native_logout).toBe(false)
    expect((await runCli(daemon.socket, 'account', 'verify', account.id, 'bad', '{}')).output).toMatchObject({
      type: 'error',
      code: 'usage',
    })
  } finally {
    await daemon.stop()
  }
})

test('CLI verifies and sends through a managed Claude account using an external provider fixture', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-cli-account-provider-'))
  const nativeCli = join(fixtures, 'claude')
  const bridge = join(fixtures, 'bridge.mjs')
  await writeFile(
    nativeCli,
    `#!/usr/bin/env node
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
`,
  )
  await chmod(nativeCli, 0o700)
  await writeFile(
    bridge,
    `#!/usr/bin/env node
import { join } from 'node:path';
import { serve } from ${JSON.stringify(pathToFileURL(resolve('providers/claude/bridge.mjs')).href)};
import { fakeSdk } from ${JSON.stringify(pathToFileURL(resolve('providers/claude/fake-sdk.mjs')).href)};
serve(fakeSdk(join(process.env.CLAUDE_CONFIG_DIR, 'sessions')));
`,
  )
  await chmod(bridge, 0o700)
  const daemon = await startDaemon({
    ADE_CLAUDE_BIN: nativeCli,
    ADE_CLAUDE_BRIDGE_BIN: bridge,
    ANTHROPIC_API_KEY: 'ambient-credential-must-not-be-used',
  })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as {
      id: string
    }
    const created = await runCli(daemon.socket, 'account', 'create', 'claude', 'Fixture account')
    const account = created.output.account as { id: string; native_home: string; generation: number }
    await writeFile(
      join(account.native_home, 'identity.json'),
      JSON.stringify({ email: 'cli@example.invalid', orgId: 'org-cli' }),
    )
    const inspection = (await runCli(daemon.socket, 'account', 'inspect', account.id)).output.inspection as {
      state: string
      identity: Record<string, unknown>
    }
    expect(inspection).toMatchObject({ state: 'ready', identity: { email: 'cli@example.invalid' } })
    const wrongIdentity = await runCli(
      daemon.socket,
      'account',
      'verify',
      account.id,
      '0',
      JSON.stringify({ ...inspection.identity, email: 'changed@example.invalid' }),
    )
    expect(wrongIdentity).toMatchObject({ code: 7, output: { type: 'error', code: 'daemon' } })
    const verified = await runCli(
      daemon.socket,
      'account',
      'verify',
      account.id,
      '0',
      JSON.stringify(inspection.identity),
    )
    expect(verified.output.account).toMatchObject({
      state: 'verified',
      claude_identity: { email: 'cli@example.invalid', org_id: 'org-cli' },
    })
    const createdConversation = await runCli(
      daemon.socket,
      'conversation',
      'create',
      workspace.id,
      'claude',
      'CLI fixture',
      '--account',
      account.id,
    )
    const conversation = createdConversation.output.conversation as { id: string }
    const send = await runCli(daemon.socket, 'conversation', 'send', conversation.id, 'hello from CLI')
    expect(send).toMatchObject({ code: 0, output: { request_id: expect.any(String) } })
    await expect
      .poll(async () => (await runCli(daemon.socket, 'conversation', 'inspect', conversation.id)).output.conversation)
      .toMatchObject({ status: 'ready', account_id: account.id })
    const calls = await readFile(join(account.native_home, 'sessions', 'calls.jsonl'), 'utf8')
    expect(calls).toContain('hello from CLI')
  } finally {
    await daemon.stop()
    await rm(fixtures, { recursive: true, force: true })
  }
})
