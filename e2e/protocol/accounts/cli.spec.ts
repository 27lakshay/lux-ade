// F026 and F027 through the CLI: managed account metadata, explicit account
// selection, verification against an external provider CLI fixture, and
// managed Oh My Pi homes that pin separate native OAuth credentials and
// refuse drift, workspace .env fallbacks and overrides before any turn.
// Ported from the legacy e2e/specs/local-cli (account cases) and
// omp-account-readiness specs.
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type ScratchProfile } from '../fixtures'
import { repositoryRoot } from '../fixtures/environment'

const run = promisify(execFile)

type Account = {
  id: string
  native_home: string
  generation: number
  state: string
  omp_identity?: Record<string, unknown>
}

async function workspaceOf(profile: ScratchProfile): Promise<string> {
  return (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace.id
}

test('CLI exposes managed account metadata and requires explicit account selection', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_CLAUDE_BIN: join(ade.root, 'ade-missing-claude-cli') } })
  const workspace_id = await workspaceOf(profile)
  const created = await profile.cli('account', 'create', 'claude', 'Work Claude')
  expect(created).toMatchObject({ code: 0, json: { type: 'ack' } })
  const account = created.json!.account as Account
  expect(account).toMatchObject({ generation: 0, state: 'unverified' })
  expect(account.native_home).toContain(profile.dataDirectory)

  const listed = await profile.cli('account', 'list')
  expect(listed.code).toBe(0)
  expect(listed.json!.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ id: account.id })]))
  expect(await profile.cli('account', 'inspect', account.id)).toMatchObject({
    code: 0,
    json: { type: 'account_inspection', inspection: { state: 'missing_executable' } },
  })
  const verification = await profile.cli(
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
  expect(verification).toMatchObject({ code: 7, json: { type: 'error', code: 'daemon' } })
  expect(String(verification.json!.message)).toMatch(/not ready/)

  // An account ID in the title position is ambiguous; --account names it.
  expect(await profile.cli('conversation', 'create', workspace_id, 'claude', account.id)).toMatchObject({
    code: 2,
    json: { type: 'error', code: 'usage' },
  })
  const conversation = await profile.cli(
    'conversation',
    'create',
    workspace_id,
    'claude',
    'Managed',
    '--account',
    account.id,
  )
  expect(conversation.code).toBe(0)
  expect(conversation.json!.conversation).toMatchObject({ account_id: account.id, account_context: 'managed' })
  const disabled = await profile.cli('account', 'disable', account.id)
  expect(disabled.json!.account).toMatchObject({ id: account.id, generation: 1, state: 'disabled' })
  expect(disabled.json!.native_logout).toBe(false)
  expect((await profile.cli('account', 'verify', account.id, 'bad', '{}')).json).toMatchObject({
    type: 'error',
    code: 'usage',
  })
})

test('CLI verifies and sends through a managed Claude account using an external provider fixture', async ({ ade }) => {
  const nativeCli = join(ade.root, 'claude')
  const bridge = join(ade.root, 'bridge.mjs')
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
  const provider = (file: string) => JSON.stringify(pathToFileURL(join(repositoryRoot, 'providers/claude', file)).href)
  await writeFile(
    bridge,
    `#!/usr/bin/env node
import { join } from 'node:path';
import { serve } from ${provider('bridge.mjs')};
import { fakeSdk } from ${provider('fake-sdk.mjs')};
serve(fakeSdk(join(process.env.CLAUDE_CONFIG_DIR, 'sessions')));
`,
  )
  await chmod(bridge, 0o700)
  const profile = await ade.profile({
    env: {
      ADE_CLAUDE_BIN: nativeCli,
      ADE_CLAUDE_BRIDGE_BIN: bridge,
      ANTHROPIC_API_KEY: 'ambient-credential-must-not-be-used',
    },
  })
  const workspace_id = await workspaceOf(profile)
  const account = (await profile.cli('account', 'create', 'claude', 'Fixture account')).json!.account as Account
  await writeFile(
    join(account.native_home, 'identity.json'),
    JSON.stringify({ email: 'cli@example.invalid', orgId: 'org-cli' }),
  )
  const inspection = (await profile.cli('account', 'inspect', account.id)).json!.inspection as {
    state: string
    identity: Record<string, unknown>
  }
  expect(inspection).toMatchObject({ state: 'ready', identity: { email: 'cli@example.invalid' } })
  // A pinned identity must match what the inspection read.
  expect(
    await profile.cli(
      'account',
      'verify',
      account.id,
      '0',
      JSON.stringify({ ...inspection.identity, email: 'changed@example.invalid' }),
    ),
  ).toMatchObject({ code: 7, json: { type: 'error', code: 'daemon' } })
  const verified = await profile.cli('account', 'verify', account.id, '0', JSON.stringify(inspection.identity))
  expect(verified.json!.account).toMatchObject({
    state: 'verified',
    claude_identity: { email: 'cli@example.invalid', org_id: 'org-cli' },
  })
  const conversation = (
    await profile.cli('conversation', 'create', workspace_id, 'claude', 'CLI fixture', '--account', account.id)
  ).json!.conversation as { id: string }
  const sent = await profile.cli('conversation', 'send', conversation.id, 'hello from CLI')
  expect(sent).toMatchObject({ code: 0, json: { request_id: expect.any(String) } })
  await expect
    .poll(async () => (await profile.cli('conversation', 'inspect', conversation.id)).json!.conversation)
    .toMatchObject({ status: 'ready', account_id: account.id })
  expect(await readFile(join(account.native_home, 'sessions', 'calls.jsonl'), 'utf8')).toContain('hello from CLI')
})

/** Write one Oh My Pi native OAuth credential into the account's agent.db. */
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
  await run('bun', ['-e', code, db, String(id), email])
  await chmod(db, 0o600)
}

test('managed Oh My Pi homes pin separate native OAuth credentials and reject drift before turns', async ({ ade }) => {
  const fixtureDir = join(ade.root, 'omp-native')
  const executable = join(fixtureDir, 'omp')
  await mkdir(fixtureDir, { recursive: true })
  await copyFile(join(repositoryRoot, 'e2e/fixtures/omp_account_cli.mjs'), executable)
  await chmod(executable, 0o700)
  const profile = await ade.profile({
    env: {
      ADE_OMP_BIN: executable,
      ANTHROPIC_API_KEY: 'ambient-must-not-leak',
      OPENAI_API_KEY: 'ambient-must-not-leak',
      PI_CODING_AGENT_DIR: join(ade.root, 'ambient-must-not-be-used'),
    },
  })
  const cli = async (...args: string[]) => {
    const result = await profile.cli(...args)
    expect(result.code, result.stderr).toBe(0)
    return result.json!
  }
  const inspect = async (id: string) =>
    (await cli('account', 'inspect', id)).inspection as {
      state: string
      identity: Record<string, unknown> | null
      reason: string
    }
  const snapshot = async (id: string) =>
    (await profile.call('conversation.get', { conversation_id: id })).conversation as {
      status: string
      error: string | null
      provider_thread_id: string | null
    }
  const workspace_id = await workspaceOf(profile)
  const one = (await cli('account', 'create', 'omp', 'First')).account as Account
  const two = (await cli('account', 'create', 'omp', 'Second')).account as Account
  expect(one.native_home).not.toBe(two.native_home)
  const emptyInspection = await inspect(one.id)
  expect(emptyInspection.state, JSON.stringify(emptyInspection)).toBe('unauthenticated')
  await nativeCredential(one, 'first@example.invalid', 10)
  await nativeCredential(two, 'second@example.invalid', 20)
  const firstIdentity = (await inspect(one.id)).identity!
  const secondIdentity = (await inspect(two.id)).identity!
  expect(firstIdentity).toMatchObject({ provider: 'anthropic', credential_id: 10, email: 'first@example.invalid' })
  expect(secondIdentity).toMatchObject({ provider: 'anthropic', credential_id: 20, email: 'second@example.invalid' })
  await expect(
    profile.call('account.verify', { account_id: one.id, expected_generation: 0, expected_identity: secondIdentity }),
  ).rejects.toThrow(/identity changed/)
  expect((await cli('account', 'verify', one.id, '0', JSON.stringify(firstIdentity))).account).toMatchObject({
    state: 'verified',
    omp_identity: firstIdentity,
  })
  expect((await cli('account', 'verify', two.id, '0', JSON.stringify(secondIdentity))).account).toMatchObject({
    state: 'verified',
    omp_identity: secondIdentity,
  })

  // Each conversation runs in its own account's home with no ambient credential.
  const a = (await cli('conversation', 'create', workspace_id, 'omp', 'First turn', '--account', one.id))
    .conversation as { id: string }
  const b = (await cli('conversation', 'create', workspace_id, 'omp', 'Second turn', '--account', two.id))
    .conversation as { id: string }
  await cli('conversation', 'send', a.id, 'hello first')
  await cli('conversation', 'send', b.id, 'hello second')
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
  for (const [calls, account] of [
    [callsOne, one],
    [callsTwo, two],
  ] as const) {
    expect(JSON.parse(calls.trim())).toMatchObject({
      userHome: account.native_home,
      managedHome: account.native_home,
      config: account.native_home,
    })
  }
  expect(JSON.stringify(await cli('account', 'list'))).not.toContain('synthetic-secret')

  // A workspace .env could supply a fallback credential, so the native CLI never starts.
  await writeFile(join(profile.defaultWorkspaceRoot, '.env'), 'ANTHROPIC_API_KEY=workspace-fallback-must-not-run\n')
  const launchesBeforeEnv = (await readFile(join(two.native_home, 'launches'), 'utf8')).trim().split('\n').length
  const blocked = (await cli('conversation', 'create', workspace_id, 'omp', 'Blocked at launch', '--account', two.id))
    .conversation as { id: string }
  await cli('conversation', 'send', blocked.id, 'workspace env cannot launch')
  await expect.poll(async () => (await snapshot(blocked.id)).error).toMatch(/cannot load native \.env files/)
  expect((await snapshot(blocked.id)).provider_thread_id).toBeNull()
  expect((await readFile(join(two.native_home, 'launches'), 'utf8')).trim().split('\n')).toHaveLength(launchesBeforeEnv)
  await cli('conversation', 'send', b.id, 'workspace env must not run')
  await expect.poll(async () => (await snapshot(b.id)).error).toMatch(/cannot load native \.env files/)
  expect(await readFile(join(two.native_home, 'calls.jsonl'), 'utf8')).not.toContain('workspace env must not run')
  await rm(join(profile.defaultWorkspaceRoot, '.env'))

  // A changed native credential is caught before the turn is dispatched.
  await nativeCredential(one, 'drift@example.invalid', 21)
  await cli('conversation', 'send', a.id, 'must not dispatch')
  await expect.poll(async () => (await snapshot(a.id)).error).toMatch(/identity changed before starting a turn/)
  expect(await readFile(join(one.native_home, 'calls.jsonl'), 'utf8')).not.toContain('must not dispatch')
  await nativeCredential(one, 'first@example.invalid', 10)

  // Overrides and ambiguous credentials make the account incompatible.
  await writeFile(join(two.native_home, 'models.yml'), 'providers:\n  anthropic:\n    apiKey: alternate-secret\n')
  expect(await inspect(two.id)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/overrides/) })
  await rm(join(two.native_home, 'models.yml'))
  await writeFile(join(two.native_home, 'config.yaml'), 'auth:\n  broker:\n    url: https://alternate.invalid\n')
  expect(await inspect(two.id)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/overrides/) })
  await rm(join(two.native_home, 'config.yaml'))
  await run('bun', [
    '-e',
    `import { Database } from 'bun:sqlite';
const db = new Database(process.argv[1]);
db.query('INSERT INTO auth_credentials(id,provider,credential_type,data,disabled_cause,identity_key) VALUES(30,?,?,?,?,?)').run(
  'anthropic', 'oauth', JSON.stringify({ email: 'third@example.invalid', accountId: 'third@example.invalid',
    access: 'other-secret' }), null, 'email:third@example.invalid'); db.close();`,
    join(two.native_home, 'agent.db'),
  ])
  expect(await inspect(two.id)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/exactly one/) })

  // A disabled account refuses a turn before anything is sent.
  await profile.call('account.disable', { account_id: one.id })
  await expect(
    profile.call('agent.send', { conversation_id: a.id, request_id: 'disabled-turn', text: 'must not dispatch' }),
  ).rejects.toThrow(/account is disabled/)
  await rm(join(two.native_home, 'agent.db'))
  expect(await inspect(two.id)).toMatchObject({ state: 'unauthenticated' })
  await writeFile(join(fixtureDir, 'version'), 'omp/18.4.0\n')
  expect(await inspect(two.id)).toMatchObject({ state: 'incompatible', reason: expect.stringMatching(/version/) })
  await rm(join(fixtureDir, 'version'))
  await rm(executable)
  expect(await inspect(two.id)).toMatchObject({ state: 'missing_executable' })
})
