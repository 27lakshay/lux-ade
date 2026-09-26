import { expect, test } from '@playwright/test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { rpc, startDaemon } from '../fixtures/daemon'

type Account = { id: string; native_home: string; generation: number; state: string;
  claude_identity?: { email: string; org_id: string } }
type ClaudeIdentity = { auth_method: string; api_provider: string; email: string; org_id: string }
type Conversation = { id: string; provider_thread_id: string | null; status: string; error: string | null }

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
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  if (!existsSync(join(home, 'identity.json'))) process.exit(1);
  const identity = JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8'));
  const ambient = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_BASE_URL);
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: ambient ? 'api_key' : 'claude.ai',
    apiProvider: 'firstParty', configDirectory: home, email: identity.email, orgId: identity.orgId }) + '\\n');
} else process.exit(2);
`

test('managed Claude accounts verify, launch separately, and reject identity drift', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-managed-claude-'))
  const cli = join(fixtures, 'claude')
  const bridge = join(fixtures, 'bridge.mjs')
  await writeFile(cli, nativeCli)
  await chmod(cli, 0o700)
  await writeFile(bridge, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from ${JSON.stringify(pathToFileURL(resolve('providers/claude/bridge.mjs')).href)};
import { fakeSdk } from ${JSON.stringify(pathToFileURL(resolve('providers/claude/fake-sdk.mjs')).href)};
const home = process.env.CLAUDE_CONFIG_DIR;
appendFileSync(join(home, 'launches'), 'launch\\n');
writeFileSync(join(home, 'environment.json'), JSON.stringify({
  config: process.env.CLAUDE_CONFIG_DIR, anthropicConfig: process.env.ANTHROPIC_CONFIG_DIR,
  ambientKey: !!process.env.ANTHROPIC_API_KEY, ambientToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ambientGateway: !!process.env.ANTHROPIC_BASE_URL,
}));
serve(fakeSdk(join(home, 'sessions')));
`)
  await chmod(bridge, 0o700)
  const daemon = await startDaemon({ ADE_CLAUDE_BIN: cli, ADE_CLAUDE_BRIDGE_BIN: bridge,
    CLAUDE_CONFIG_DIR: join(fixtures, 'ambient'), ANTHROPIC_API_KEY: 'must-not-leak',
    CLAUDE_CODE_OAUTH_TOKEN: 'must-not-leak', ANTHROPIC_BASE_URL: 'https://ambient.invalid' })
  const inspect = (id: string) => rpc(daemon.socket, { op: 'account.inspect', account_id: id })
  const inspectedIdentity = async (id: string): Promise<ClaudeIdentity> => {
    const identity = ((await inspect(id)).inspection as { identity: ClaudeIdentity | null }).identity
    if (!identity) throw new Error('Fixture account was not ready')
    return identity
  }
  const verify = (account: Account, expectedIdentity: ClaudeIdentity) => rpc(daemon.socket, { op: 'account.verify',
    account_id: account.id, expected_generation: account.generation, expected_identity: expectedIdentity })
  const snapshot = async (id: string) => (await rpc(daemon.socket, { op: 'conversation.get', conversation_id: id })).conversation as Conversation
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as { id: string }
    const first = (await rpc(daemon.socket, { op: 'account.create', provider: 'claude', name: 'One' })).account as Account
    const second = (await rpc(daemon.socket, { op: 'account.create', provider: 'claude', name: 'Two' })).account as Account
    await writeFile(join(first.native_home, 'identity.json'), JSON.stringify({ email: 'one@example.invalid', orgId: 'org-one' }))
    await writeFile(join(second.native_home, 'identity.json'), JSON.stringify({ email: 'two@example.invalid', orgId: 'org-two' }))
    const firstIdentity = await inspectedIdentity(first.id)
    const secondIdentity = await inspectedIdentity(second.id)
    expect(firstIdentity.email).toBe('one@example.invalid')
    expect(secondIdentity.email).toBe('two@example.invalid')
    await expect(rpc(daemon.socket, { op: 'account.verify', account_id: first.id,
      expected_generation: first.generation })).rejects.toThrow(/Missing inspected Claude identity/)
    await writeFile(join(first.native_home, 'identity.json'), JSON.stringify({ email: 'changed@example.invalid', orgId: 'changed-org' }))
    await expect(verify(first, firstIdentity)).rejects.toThrow(/identity changed since inspection/)
    expect((await rpc(daemon.socket, { op: 'account.list' })).accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, state: 'unverified' }),
    ]))
    await writeFile(join(first.native_home, 'identity.json'), JSON.stringify({ email: 'one@example.invalid', orgId: 'org-one' }))
    const boundFirst = (await verify(first, firstIdentity)).account as Account
    const boundSecond = (await verify(second, secondIdentity)).account as Account
    expect(boundFirst).toMatchObject({ state: 'verified', claude_identity: { email: 'one@example.invalid', org_id: 'org-one' } })
    expect(boundSecond).toMatchObject({ state: 'verified', claude_identity: { email: 'two@example.invalid', org_id: 'org-two' } })

    const a = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'claude', account_id: first.id })).conversation as Conversation
    const b = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'claude', account_id: second.id })).conversation as Conversation
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: a.id, request_id: 'one-turn', text: 'hello one' })
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: b.id, request_id: 'two-turn', text: 'hello two' })
    await expect.poll(async () => {
      const current = await snapshot(a.id)
      return `${current.status}: ${current.error ?? ''}`
    }).toBe('ready: ')
    await expect.poll(async () => {
      const current = await snapshot(b.id)
      return `${current.status}: ${current.error ?? ''}`
    }).toBe('ready: ')
    const aSession = (await snapshot(a.id)).provider_thread_id
    const bSession = (await snapshot(b.id)).provider_thread_id
    expect(aSession).toBeTruthy()
    expect(bSession).toBeTruthy()
    expect(aSession).not.toBe(bSession)
    for (const account of [first, second]) {
      const environment = JSON.parse(await readFile(join(account.native_home, 'environment.json'), 'utf8')) as Record<string, unknown>
      expect(environment).toMatchObject({ config: account.native_home, anthropicConfig: account.native_home,
        ambientKey: false, ambientToken: false, ambientGateway: false })
    }
    const firstCalls = await readFile(join(first.native_home, 'sessions', 'calls.jsonl'), 'utf8')
    const secondCalls = await readFile(join(second.native_home, 'sessions', 'calls.jsonl'), 'utf8')
    expect(firstCalls).toContain('hello one')
    expect(firstCalls).not.toContain('hello two')
    expect(secondCalls).toContain('hello two')
    expect(secondCalls).not.toContain('hello one')

    await rpc(daemon.socket, { op: 'agent.disconnect', conversation_id: a.id })
    await writeFile(join(first.native_home, 'identity.json'), JSON.stringify({ email: 'other@example.invalid', orgId: 'org-other' }))
    expect((await inspect(first.id)).inspection).toMatchObject({ state: 'ready', identity: { email: 'other@example.invalid' } })
    await expect(verify(first, firstIdentity)).rejects.toThrow(/identity changed/)
    await rpc(daemon.socket, { op: 'agent.resume', conversation_id: a.id })
    await expect.poll(async () => (await snapshot(a.id)).error).toMatch(/identity changed/)
    expect((await snapshot(a.id)).provider_thread_id).toBe(aSession)
    expect((await readFile(join(first.native_home, 'launches'), 'utf8')).trim().split('\n')).toHaveLength(1)

    await rm(cli)
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'missing_executable' })
    await writeFile(cli, nativeCli)
    await chmod(cli, 0o700)
    await writeFile(join(second.native_home, 'version'), '2.2.0 (Claude Code)\n')
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'incompatible' })
    await rm(join(second.native_home, 'version'))
    await rm(join(second.native_home, 'identity.json'))
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'unauthenticated' })

    await writeFile(join(second.native_home, 'identity.json'), JSON.stringify({ email: 'two@example.invalid', orgId: 'org-two' }))
    await writeFile(join(second.native_home, 'delay'), '')
    const lateVerify = verify(second, await inspectedIdentity(second.id))
    await delay(100)
    const disabled = (await rpc(daemon.socket, { op: 'account.disable', account_id: second.id })).account as Account
    expect(disabled).toMatchObject({ state: 'disabled', generation: 1 })
    await expect(lateVerify).rejects.toThrow(/changed during verification/)
    const accounts = (await rpc(daemon.socket, { op: 'account.list' })).accounts as Account[]
    expect(accounts.find(item => item.id === second.id)).toMatchObject({ state: 'disabled', generation: 1 })

    const third = (await rpc(daemon.socket, { op: 'account.create', provider: 'claude', name: 'Launch race' })).account as Account
    await writeFile(join(third.native_home, 'identity.json'), JSON.stringify({ email: 'third@example.invalid', orgId: 'org-third' }))
    await verify(third, await inspectedIdentity(third.id))
    const c = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'claude', account_id: third.id })).conversation as Conversation
    await writeFile(join(third.native_home, 'delay'), '')
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: c.id, request_id: 'race-turn', text: 'must not run' })
    await expect.poll(async () => readFile(join(third.native_home, 'probe-started'), 'utf8').catch(() => '')).toBe('yes')
    const disabledDuringLaunch = (await rpc(daemon.socket, { op: 'account.disable', account_id: third.id })).account as Account
    expect(disabledDuringLaunch).toMatchObject({ state: 'disabled', generation: 1 })
    await expect.poll(async () => (await snapshot(c.id)).error).toMatch(/Account changed before provider session opened/)
    expect((await snapshot(c.id)).provider_thread_id).toBeNull()
    await expect(readFile(join(third.native_home, 'sessions', 'calls.jsonl'))).rejects.toThrow()

    const fourth = (await rpc(daemon.socket, { op: 'account.create', provider: 'claude', name: 'Updated executable' })).account as Account
    await writeFile(join(fourth.native_home, 'identity.json'), JSON.stringify({ email: 'fourth@example.invalid', orgId: 'org-fourth' }))
    await verify(fourth, await inspectedIdentity(fourth.id))
    const d = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'claude', account_id: fourth.id })).conversation as Conversation
    await writeFile(join(fourth.native_home, 'delay'), '')
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: d.id, request_id: 'replacement-turn', text: 'must not run' })
    await expect.poll(async () => readFile(join(fourth.native_home, 'probe-started'), 'utf8').catch(() => '')).toBe('yes')
    await writeFile(cli, `${nativeCli}\n// external replacement\n`)
    await expect.poll(async () => (await snapshot(d.id)).error).toMatch(/executable changed/)
    expect((await snapshot(d.id)).provider_thread_id).toBeNull()
    await expect(readFile(join(fourth.native_home, 'sessions', 'calls.jsonl'))).rejects.toThrow()
  } finally {
    await daemon.stop().catch(() => undefined)
    await rm(fixtures, { recursive: true, force: true })
  }
})
