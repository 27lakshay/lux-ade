import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')
const native = resolve('e2e/fixtures/omp_account_cli.mjs')
type Account = { id: string; native_home: string; generation: number; state: string;
  omp_identity?: Record<string, unknown> }
type Conversation = { id: string; status: string; error: string | null; provider_thread_id: string | null }

async function runCli(socket: string, ...args: string[]): Promise<Record<string, unknown>> {
  const output = await execFileAsync(process.execPath, [cli, '--socket', socket, ...args], { timeout: 12_000 })
  return JSON.parse(output.stdout) as Record<string, unknown>
}

async function nativeCredential(account: Account, email: string, id: number): Promise<void> {
  const db = join(account.native_home, 'agent.db')
  const code = `import { Database } from 'bun:sqlite';
const db = new Database(process.argv[1], { create: true });
db.run('CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT)');
db.run('DELETE FROM auth_credentials');
db.query('INSERT INTO auth_credentials(id,provider,credential_type,data,disabled_cause,identity_key) VALUES(?1,?2,?3,?4,NULL,?5)').run(
  Number(process.argv[2]), 'anthropic', 'oauth', JSON.stringify({ email: process.argv[3], accountId: process.argv[3],
    access: 'synthetic-secret', refresh: 'synthetic-refresh' }), 'email:' + process.argv[3]);
db.close();`
  await execFileAsync('bun', ['-e', code, db, String(id), email])
  await chmod(db, 0o600)
}

test('managed Oh My Pi homes pin separate native OAuth credentials and reject drift before turns', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'ade-omp-native-'))
  const executable = join(fixtureDir, 'omp')
  await copyFile(native, executable)
  await chmod(executable, 0o700)
  const daemon = await startDaemon({ ADE_OMP_BIN: executable, ANTHROPIC_API_KEY: 'ambient-must-not-leak',
    OPENAI_API_KEY: 'ambient-must-not-leak', PI_CODING_AGENT_DIR: '/tmp/ambient-must-not-be-used' })
  const inspect = async (id: string) => (await runCli(daemon.socket, 'account', 'inspect', id)).inspection as
    { state: string; identity: Record<string, unknown> | null; reason: string }
  const snapshot = async (id: string) => (await rpc(daemon.socket, { op: 'conversation.get', conversation_id: id })).conversation as Conversation
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as { id: string }
    const one = (await runCli(daemon.socket, 'account', 'create', 'omp', 'First')).account as Account
    const two = (await runCli(daemon.socket, 'account', 'create', 'omp', 'Second')).account as Account
    expect(one.native_home).not.toBe(two.native_home)
    const emptyInspection = await inspect(one.id)
    expect(emptyInspection.state, JSON.stringify(emptyInspection)).toBe('unauthenticated')
    await nativeCredential(one, 'first@example.invalid', 10)
    await nativeCredential(two, 'second@example.invalid', 20)
    const firstIdentity = (await inspect(one.id)).identity!
    const secondIdentity = (await inspect(two.id)).identity!
    expect(firstIdentity).toMatchObject({ provider: 'anthropic', credential_id: 10, email: 'first@example.invalid' })
    expect(secondIdentity).toMatchObject({ provider: 'anthropic', credential_id: 20, email: 'second@example.invalid' })
    await expect(rpc(daemon.socket, { op: 'account.verify', account_id: one.id,
      expected_generation: 0, expected_identity: secondIdentity })).rejects.toThrow(/identity changed/)
    expect((await runCli(daemon.socket, 'account', 'verify', one.id, '0', JSON.stringify(firstIdentity))).account)
      .toMatchObject({ state: 'verified', omp_identity: firstIdentity })
    expect((await runCli(daemon.socket, 'account', 'verify', two.id, '0', JSON.stringify(secondIdentity))).account)
      .toMatchObject({ state: 'verified', omp_identity: secondIdentity })
    const a = (await runCli(daemon.socket, 'conversation', 'create', workspace.id, 'omp', 'First turn', '--account', one.id))
      .conversation as Conversation
    const b = (await runCli(daemon.socket, 'conversation', 'create', workspace.id, 'omp', 'Second turn', '--account', two.id))
      .conversation as Conversation
    await runCli(daemon.socket, 'conversation', 'send', a.id, 'hello first')
    await runCli(daemon.socket, 'conversation', 'send', b.id, 'hello second')
    await expect.poll(async () => (await snapshot(a.id)).status).toBe('ready')
    await expect.poll(async () => (await snapshot(b.id)).status).toBe('ready')
    expect((await snapshot(a.id)).provider_thread_id).toBeTruthy()
    expect((await snapshot(b.id)).provider_thread_id).toBeTruthy()
    expect((await snapshot(a.id)).provider_thread_id).not.toBe((await snapshot(b.id)).provider_thread_id)
    const callsOne = await readFile(join(one.native_home, 'calls.jsonl'), 'utf8')
    const callsTwo = await readFile(join(two.native_home, 'calls.jsonl'), 'utf8')
    expect(callsOne).toContain('hello first')
    expect(callsOne).not.toContain('hello second')
    expect(callsTwo).toContain('hello second')
    expect(callsTwo).not.toContain('hello first')
    for (const calls of [callsOne, callsTwo]) {
      expect(calls).toContain('"ambient":false')
      expect(calls).not.toContain('ambient-must-not-leak')
    }
    expect(JSON.parse(callsOne.trim())).toMatchObject({ userHome: one.native_home, managedHome: one.native_home, config: one.native_home })
    expect(JSON.parse(callsTwo.trim())).toMatchObject({ userHome: two.native_home, managedHome: two.native_home, config: two.native_home })
    expect(JSON.stringify(await runCli(daemon.socket, 'account', 'list'))).not.toContain('synthetic-secret')

    await writeFile(join(daemon.rootDirectory, '.env'), 'ANTHROPIC_API_KEY=workspace-fallback-must-not-run\n')
    const launchesBeforeEnv = (await readFile(join(two.native_home, 'launches'), 'utf8')).trim().split('\n').length
    const blocked = (await runCli(daemon.socket, 'conversation', 'create', workspace.id, 'omp', 'Blocked at launch',
      '--account', two.id)).conversation as Conversation
    await runCli(daemon.socket, 'conversation', 'send', blocked.id, 'workspace env cannot launch')
    await expect.poll(async () => (await snapshot(blocked.id)).error).toMatch(/cannot load native \.env files/)
    expect((await snapshot(blocked.id)).provider_thread_id).toBeNull()
    expect((await readFile(join(two.native_home, 'launches'), 'utf8')).trim().split('\n')).toHaveLength(launchesBeforeEnv)
    await runCli(daemon.socket, 'conversation', 'send', b.id, 'workspace env must not run')
    await expect.poll(async () => (await snapshot(b.id)).error).toMatch(/cannot load native \.env files/)
    expect(await readFile(join(two.native_home, 'calls.jsonl'), 'utf8')).not.toContain('workspace env must not run')
    await rm(join(daemon.rootDirectory, '.env'))

    await nativeCredential(one, 'drift@example.invalid', 21)
    await runCli(daemon.socket, 'conversation', 'send', a.id, 'must not dispatch')
    await expect.poll(async () => (await snapshot(a.id)).error).toMatch(/identity changed before starting a turn/)
    expect(await readFile(join(one.native_home, 'calls.jsonl'), 'utf8')).not.toContain('must not dispatch')
    await nativeCredential(one, 'first@example.invalid', 10)
    await writeFile(join(two.native_home, 'models.yml'), 'providers:\n  anthropic:\n    apiKey: alternate-secret\n')
    expect(await inspect(two.id)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/overrides/) })
    await rm(join(two.native_home, 'models.yml'))
    await writeFile(join(two.native_home, 'config.yaml'), 'auth:\n  broker:\n    url: https://alternate.invalid\n')
    expect(await inspect(two.id)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/overrides/) })
    await rm(join(two.native_home, 'config.yaml'))
    await execFileAsync('bun', ['-e', `import { Database } from 'bun:sqlite';
const db = new Database(process.argv[1]);
db.query('INSERT INTO auth_credentials(id,provider,credential_type,data,disabled_cause,identity_key) VALUES(30,?,?,?,?,?)').run(
  'anthropic', 'oauth', JSON.stringify({ email: 'third@example.invalid', accountId: 'third@example.invalid',
    access: 'other-secret' }), null, 'email:third@example.invalid'); db.close();`, join(two.native_home, 'agent.db')])
    expect(await inspect(two.id)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/exactly one/) })
    await rpc(daemon.socket, { op: 'account.disable', account_id: one.id })
    await expect(rpc(daemon.socket, { op: 'agent.send', conversation_id: a.id,
      request_id: 'disabled-turn', text: 'must not dispatch' })).rejects.toThrow(/account is not verified/)
    await rm(join(two.native_home, 'agent.db'))
    expect(await inspect(two.id)).toMatchObject({ state: 'unauthenticated' })
    await writeFile(join(fixtureDir, 'version'), 'omp/18.4.0\n')
    expect(await inspect(two.id)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/version/) })
    await rm(join(fixtureDir, 'version'))
    await rm(executable)
    expect(await inspect(two.id)).toMatchObject({ state: 'missing_executable' })
  } finally {
    await daemon.stop()
    await rm(fixtureDir, { recursive: true, force: true })
  }
})
