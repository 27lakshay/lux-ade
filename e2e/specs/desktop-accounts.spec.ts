import { expect, test, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, stopManagedProfiles, type ManagedProfileOwner, rpc, startDaemon } from '../fixtures/daemon'

const desktopDirectory = resolve('apps/desktop')
const requireDesktop = createRequire(join(desktopDirectory, 'package.json'))
const electronExecutable = requireDesktop('electron') as string
const execFileAsync = promisify(execFile)

async function profileSocket(home: string): Promise<string> {
  const result = await execFileAsync('python3', [resolve('scripts/runtime.py'), 'locate', '--home', home])
  return (JSON.parse(result.stdout) as { socket: string }).socket
}



type Account = { id: string; name: string; native_home: string; generation: number; state: string;
  claude_identity?: { email: string; org_id: string } }

const nativeCli = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CLAUDE_CONFIG_DIR;
if (process.argv[2] === '--version') {
  process.stdout.write(existsSync(join(home, 'version')) ? readFileSync(join(home, 'version'), 'utf8') : '2.1.283 (Claude Code)\\n');
} else if (process.argv.at(-2) === 'auth' && process.argv.at(-1) === 'status'
  && process.argv[2] === '--setting-sources' && process.argv[3] === '') {
  if (existsSync(join(home, 'delay'))) {
    writeFileSync(join(home, 'probe-started'), 'yes');
    while (!existsSync(join(home, 'continue'))) await new Promise(resolve => setTimeout(resolve, 10));
    writeFileSync(join(home, 'probe-finished'), 'yes');
  }
  if (!existsSync(join(home, 'identity.json'))) process.exit(1);
  const identity = JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8'));
  const ambient = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_BASE_URL);
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: ambient ? 'api_key' : 'claude.ai',
    apiProvider: 'firstParty', configDirectory: home, email: identity.email, orgId: identity.orgId }) + '\\n');
} else process.exit(2);
`

test('desktop manages Claude accounts and pins conversation account selection', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-desktop-accounts-'))
  const cli = join(fixtures, 'claude')
  const userData = join(fixtures, 'electron')
  await writeFile(cli, nativeCli)
  await chmod(cli, 0o700)
  const daemon = await startDaemon({ ADE_CLAUDE_BIN: cli, ANTHROPIC_API_KEY: 'ambient-must-not-leak',
    CLAUDE_CODE_OAUTH_TOKEN: 'ambient-must-not-leak', ANTHROPIC_BASE_URL: 'https://ambient.invalid' })
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const panel = window.getByRole('region', { name: 'Accounts' })
    await panel.getByRole('textbox', { name: 'New account name' }).fill('Personal')
    await panel.getByRole('button', { name: 'Add' }).click()
    await expect(panel.getByLabel('Manage account')).toContainText('Personal')
    const list = async (): Promise<Account[]> => (await rpc(daemon.socket, { op: 'account.list' })).accounts as Account[]
    const personal = (await list()).find((account) => account.name === 'Personal')!
    expect(personal.state).toBe('unverified')
    await expect(panel.getByLabel('Account Personal')).toContainText(personal.native_home)
    await expect(panel.getByLabel('Claude login command')).toHaveText(`env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_BASE_URL CLAUDE_CONFIG_DIR='${personal.native_home}' ANTHROPIC_CONFIG_DIR='${personal.native_home}' claude auth login`)
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('unauthenticated')
    await expect(panel.getByRole('button', { name: 'Verify' })).toBeDisabled()

    await writeFile(join(personal.native_home, 'identity.json'), JSON.stringify({ email: 'personal@example.invalid', orgId: 'personal-org' }))
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('ready')
    await expect(panel.getByRole('status')).toContainText('personal@example.invalid')
    await writeFile(join(personal.native_home, 'identity.json'), JSON.stringify({ email: 'changed@example.invalid', orgId: 'changed-org' }))
    await panel.getByRole('button', { name: 'Verify' }).click()
    await expect(panel.getByRole('alert')).toContainText('identity changed since inspection')
    expect((await list()).find((account) => account.id === personal.id)?.state).toBe('unverified')
    await writeFile(join(personal.native_home, 'identity.json'), JSON.stringify({ email: 'personal@example.invalid', orgId: 'personal-org' }))
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('personal@example.invalid')
    await panel.getByRole('button', { name: 'Verify' }).click()
    await expect(panel.getByLabel('Account Personal')).toContainText('Personal · verified')
    expect((await list()).find((account) => account.id === personal.id)).toMatchObject({ generation: 0,
      claude_identity: { email: 'personal@example.invalid', org_id: 'personal-org' } })

    await panel.getByRole('textbox', { name: 'New account name' }).fill('Work')
    await panel.getByRole('button', { name: 'Add' }).click()
    const work = (await list()).find((account) => account.name === 'Work')!
    expect(work.native_home).not.toBe(personal.native_home)
    await writeFile(join(work.native_home, 'identity.json'), JSON.stringify({ email: 'work@example.invalid', orgId: 'work-org' }))
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('work@example.invalid')
    await expect(panel.getByRole('status')).not.toContainText('personal@example.invalid')
    await panel.getByRole('button', { name: 'Verify' }).click()
    await expect(panel.getByLabel('Account Work')).toContainText('Work · verified')
    await writeFile(join(work.native_home, 'identity.json'), JSON.stringify({ email: 'other@example.invalid', orgId: 'other-org' }))
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('other@example.invalid')
    await expect(panel.getByLabel('Account Work')).toContainText('work@example.invalid')
    await panel.getByRole('button', { name: 'Verify' }).click()
    await expect(panel.getByRole('alert')).toContainText('identity changed')
    await writeFile(join(work.native_home, 'identity.json'), JSON.stringify({ email: 'work@example.invalid', orgId: 'work-org' }))

    await window.getByLabel('New conversation provider').selectOption('claude')
    await window.getByLabel('New conversation account').selectOption(personal.id)
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Account: Personal')
    const catalog = await rpc(daemon.socket, { op: 'catalog.get' })
    const created = (catalog.catalog as { conversations: Array<{ account_id: string | null; account_context: string }> }).conversations[0]
    expect(created).toMatchObject({ account_id: personal.id, account_context: 'managed' })

    await panel.getByLabel('Manage account').selectOption(personal.id)
    await panel.getByRole('button', { name: 'Disable in ADE' }).click()
    await expect(panel.getByLabel('Account Personal')).toContainText('Disabled in ADE')
    await expect(window.getByRole('button', { name: 'New conversation', exact: true })).toBeDisabled()
    await expect(window.getByText('Selected account is unavailable.', { exact: false })).toBeVisible()
    await window.getByLabel('New conversation account').selectOption('')
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    await expect(conversation).toContainText('Legacy ambient account')
    const ambientCatalog = await rpc(daemon.socket, { op: 'catalog.get' })
    expect((ambientCatalog.catalog as { conversations: Array<{ account_id: string | null; account_context: string }> }).conversations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ account_id: null, account_context: 'legacy_ambient' })]))

    await panel.getByLabel('Manage account').selectOption(work.id)
    await rm(cli)
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('missing executable')
    await writeFile(cli, nativeCli)
    await chmod(cli, 0o700)
    await writeFile(join(work.native_home, 'version'), '2.2.0 (Claude Code)\n')
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('incompatible')
    expect(await window.locator('body').innerText()).not.toContain('ambient-must-not-leak')
  } finally {
    await application.close()
    await daemon.stop()
    await rm(fixtures, { recursive: true, force: true })
  }
})

test('desktop creates, verifies and runs a conversation under a private Codex account', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-desktop-codex-accounts-'))
  const cli = join(fixtures, 'codex')
  const userData = join(fixtures, 'electron')
  await copyFile(resolve('e2e/fixtures/codex_account_server.py'), cli)
  await chmod(cli, 0o700)
  const daemon = await startDaemon({ ADE_CODEX_BIN: cli, OPENAI_API_KEY: 'ambient-must-not-leak',
    CODEX_API_KEY: 'ambient-must-not-leak', CODEX_AWS_BEARER_TOKEN: 'ambient-must-not-leak' })
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const panel = window.getByRole('region', { name: 'Accounts' })
    await panel.getByLabel('New account provider').selectOption('codex')
    await panel.getByRole('textbox', { name: 'New account name' }).fill('Personal Codex')
    await panel.getByRole('button', { name: 'Add' }).click()
    const accounts = (await rpc(daemon.socket, { op: 'account.list' })).accounts as Array<Account & { provider: string;
      codex_identity?: { email: string; chatgpt_account_id: string } }>
    const account = accounts.find((item) => item.name === 'Personal Codex')!
    expect(account.provider).toBe('codex')
    await expect(panel.getByLabel('Account Personal Codex')).toContainText(account.native_home)
    await expect(panel.getByLabel('Codex login command')).toHaveText(`env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" CODEX_HOME='${account.native_home}' codex login`)
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('unauthenticated')
    await writeFile(join(account.native_home, 'auth.json'), '{}', { mode: 0o600 })
    await writeFile(join(account.native_home, 'identity.json'), JSON.stringify({
      email: 'personal@example.invalid', accountId: 'codex-personal',
    }))
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('personal@example.invalid')
    await panel.getByRole('button', { name: 'Verify' }).click()
    await expect(panel.getByLabel('Account Personal Codex')).toContainText('Personal Codex · verified')
    const boundAccounts = (await rpc(daemon.socket, { op: 'account.list' })).accounts as Array<{ id: string; codex_identity?: unknown }>
    const bound = boundAccounts.find((item) => item.id === account.id)
    expect(bound?.codex_identity).toEqual({ email: 'personal@example.invalid', chatgpt_account_id: 'codex-personal' })

    await window.getByLabel('New conversation provider').selectOption('codex')
    await window.getByLabel('New conversation account').selectOption(account.id)
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Account: Personal Codex')
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('Codex managed account')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect.poll(async () => {
      const calls = (await readFile(join(account.native_home, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
      return calls.filter((line) => JSON.parse(line).method === 'turn/start').length
    }).toBe(1)
    expect(JSON.parse(await readFile(join(account.native_home, 'environment.json'), 'utf8'))).toEqual({
      codex_home: account.native_home, openai_key: false, codex_key: false, wif: false,
    })
    expect(await window.locator('body').innerText()).not.toContain('ambient-must-not-leak')
  } finally {
    await application.close()
    await daemon.stop()
    await rm(fixtures, { recursive: true, force: true })
  }
})

test('desktop verifies and runs an Oh My Pi conversation in its private account home', async () => {
  test.setTimeout(90_000)
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-desktop-omp-account-'))
  const cli = join(fixtures, 'omp')
  const userData = join(fixtures, 'electron')
  await copyFile(resolve('e2e/fixtures/omp_account_cli.mjs'), cli)
  await chmod(cli, 0o700)
  const daemon = await startDaemon({ ADE_OMP_BIN: cli, ANTHROPIC_API_KEY: 'ambient-must-not-leak' })
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...process.env, ADE_SOCKET: daemon.socket, ADE_E2E_USER_DATA_DIR: userData, ADE_E2E_HIDE_WINDOW: '1' } })
  try {
    const window = await application.firstWindow()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const panel = window.getByRole('region', { name: 'Accounts' })
    await panel.getByLabel('New account provider').selectOption('omp')
    await panel.getByRole('textbox', { name: 'New account name' }).fill('Personal OMP')
    await panel.getByRole('button', { name: 'Add' }).click()
    await expect(panel.getByLabel('Manage account')).toContainText('Personal OMP')
    const account = ((await rpc(daemon.socket, { op: 'account.list' })).accounts as Array<Account & { provider: string }>)
      .find((item) => item.name === 'Personal OMP')!
    expect(account.provider).toBe('omp')
    await expect(panel.getByLabel('Account Personal OMP')).toContainText(account.native_home)
    const loginCommand = await panel.getByLabel('Oh My Pi login command').innerText()
    expect(loginCommand).toContain(`cd '${account.native_home}'`)
    const loginBin = join(fixtures, 'login-bin')
    await mkdir(loginBin)
    await writeFile(join(loginBin, 'omp'), `#!/bin/sh
if [ "$1" = '--version' ]; then
  if [ -f "$HOME/login-version" ]; then cat "$HOME/login-version"; else echo 'omp/18.3.0'; fi
elif [ "$1" = 'login' ]; then
  { pwd; printf '%s\\n' "\${OMP_AUTH_BROKER_URL-unset}"; } > "$HOME/login-context"
fi
`)
    await chmod(join(loginBin, 'omp'), 0o700)
    await writeFile(join(fixtures, '.env'), 'OMP_AUTH_BROKER_URL=https://workspace-broker.invalid\n')
    await execFileAsync('/bin/zsh', ['-c', loginCommand], { cwd: fixtures,
      env: { ...process.env, PATH: `${loginBin}:${process.env.PATH}`, OMP_AUTH_BROKER_URL: 'ambient-broker' } })
    expect(await readFile(join(account.native_home, 'login-context'), 'utf8'))
      .toBe(`${account.native_home}\nunset\n`)
    await rm(join(account.native_home, 'login-context'))
    await writeFile(join(account.native_home, 'login-version'), 'omp/99.0.0\n')
    await expect(execFileAsync('/bin/zsh', ['-c', loginCommand], { cwd: fixtures,
      env: { ...process.env, PATH: `${loginBin}:${process.env.PATH}` } })).rejects.toThrow()
    expect(await readFile(join(account.native_home, 'login-context'), 'utf8').catch(() => null)).toBeNull()
    await rm(join(account.native_home, 'login-version'))
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('unauthenticated')
    await expect(panel.getByRole('button', { name: 'Verify' })).toBeDisabled()

    const db = join(account.native_home, 'agent.db')
    const seed = `import { Database } from 'bun:sqlite';
const db = new Database(process.argv[1], { create: true });
db.run('CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT)');
db.query('INSERT INTO auth_credentials(id,provider,credential_type,data,disabled_cause,identity_key) VALUES(11,?,?,?,?,?)').run(
  'anthropic', 'oauth', JSON.stringify({ email: 'personal@example.invalid', accountId: 'personal-account',
    access: 'synthetic-secret' }), null, 'email:personal@example.invalid');
db.close();`
    await execFileAsync('bun', ['-e', seed, db])
    await chmod(db, 0o600)
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect(panel.getByRole('status')).toContainText('personal@example.invalid')
    await expect(panel.getByRole('status')).toContainText('anthropic OAuth credential 11')
    await panel.getByRole('button', { name: 'Verify' }).click()
    await expect(panel.getByLabel('Account Personal OMP')).toContainText('Personal OMP · verified')

    await window.getByLabel('New conversation provider').selectOption('omp')
    await window.getByLabel('New conversation account').selectOption(account.id)
    await window.getByRole('button', { name: 'New conversation', exact: true }).click()
    const conversation = window.getByRole('region', { name: 'Conversation' })
    await expect(conversation).toContainText('Account: Personal OMP')
    await conversation.getByRole('textbox', { name: 'Prompt' }).fill('Oh My Pi managed account')
    await conversation.getByRole('button', { name: 'Send' }).click()
    await expect.poll(async () => (await readFile(join(account.native_home, 'calls.jsonl'), 'utf8').catch(() => '')))
      .toContain('Oh My Pi managed account')
    expect((await readFile(join(account.native_home, 'calls.jsonl'), 'utf8'))).toContain('"ambient":false')
    expect(await window.locator('body').innerText()).not.toContain('synthetic-secret')
  } finally {
    await application.close()
    await daemon.stop()
    await rm(fixtures, { recursive: true, force: true })
  }
})

test('delayed account inspection cannot cross a desktop profile switch', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-desktop-account-profiles-'))
  const cli = join(fixtures, 'claude')
  await writeFile(cli, nativeCli)
  await chmod(cli, 0o700)
  const { ADE_SOCKET: _fixedSocket, ...environment } = process.env
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...environment, ADE_PROFILES_HOME: join(fixtures, 'profiles'),
      ADE_E2E_USER_DATA_DIR: join(fixtures, 'electron'), ADE_DAEMON_BIN: resolve('target/debug/ade-daemon'),
      ADE_CLAUDE_BIN: cli } })
  const owned: ManagedProfileOwner[] = []
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Personal')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Personal')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const personalProfile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles
      .find((item) => item.name === 'Personal')!
    const personalSocket = await profileSocket(personalProfile.home)
    owned.push(await managedProfileOwner(personalSocket))
    const panel = window.getByRole('region', { name: 'Accounts' })
    await panel.getByRole('textbox', { name: 'New account name' }).fill('Personal Claude')
    await panel.getByRole('button', { name: 'Add' }).click()
    const account = ((await rpc(personalSocket, { op: 'account.list' })).accounts as Account[])[0]
    await writeFile(join(account.native_home, 'identity.json'), JSON.stringify({ email: 'personal@example.invalid', orgId: 'personal-org' }))
    await writeFile(join(account.native_home, 'delay'), '')
    await panel.getByRole('button', { name: 'Inspect' }).click()
    await expect.poll(async () => readFile(join(account.native_home, 'probe-started'), 'utf8').catch(() => '')).toBe('yes')

    await window.getByRole('textbox', { name: 'New profile' }).fill('Work')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Work')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const workProfile = (await window.evaluate(() => window.adeHost.getProfileState())).profiles
      .find((item) => item.name === 'Work')!
    const workSocket = await profileSocket(workProfile.home)
    owned.push(await managedProfileOwner(workSocket))
    expect(await readFile(join(account.native_home, 'probe-finished'), 'utf8').catch(() => '')).toBe('')
    await writeFile(join(account.native_home, 'continue'), 'yes')
    await expect.poll(async () => readFile(join(account.native_home, 'probe-finished'), 'utf8').catch(() => '')).toBe('yes')
    await panel.getByRole('textbox', { name: 'New account name' }).fill('Work Claude')
    await panel.getByRole('button', { name: 'Add' }).click()
    await expect(panel.getByLabel('Account Work Claude')).toContainText('unverified')
    await expect(panel.getByLabel('Account Work Claude').getByRole('status')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Verify' })).toBeDisabled()
    await expect(window.locator('body')).not.toContainText('personal@example.invalid')
    expect(((await rpc(workSocket, { op: 'account.list' })).accounts as Account[])).toEqual([
      expect.objectContaining({ name: 'Work Claude', state: 'unverified' }),
    ])
    expect(((await rpc(personalSocket, { op: 'account.list' })).accounts as Account[])[0]).toMatchObject({
      id: account.id, state: 'unverified',
    })
  } finally {
    await application.close()
    await stopManagedProfiles(owned)
    await rm(fixtures, { recursive: true, force: true })
  }
})
