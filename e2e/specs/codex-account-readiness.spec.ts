import { expect, test } from '@playwright/test'
import { chmod, link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

type CodexIdentity = { email: string; chatgpt_account_id: string }
type Account = { id: string; native_home: string; state: string; generation: number; codex_identity?: CodexIdentity }
type Conversation = { id: string; provider_thread_id: string | null; status: string; error: string | null }

test('managed Codex homes verify native identity and fence drift, overrides, and disable races', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-codex-accounts-'))
  const cli = join(fixtures, 'codex')
  await writeFile(cli, await readFile(resolve('e2e/fixtures/codex_account_server.py')))
  await chmod(cli, 0o700)
  const daemon = await startDaemon({ ADE_CODEX_BIN: cli, ADE_CODEX_TRANSPORT: 'shared',
    OPENAI_API_KEY: 'ambient-must-not-leak', CODEX_API_KEY: 'ambient-must-not-leak',
    CODEX_AWS_BEARER_TOKEN: 'ambient-must-not-leak' })
  const inspect = (id: string) => rpc(daemon.socket, { op: 'account.inspect', account_id: id })
  const identity = async (id: string): Promise<CodexIdentity> => {
    const value = ((await inspect(id)).inspection as { identity: CodexIdentity | null }).identity
    if (!value) throw new Error('Fixture account is not ready')
    return value
  }
  const verify = (account: Account, expected: CodexIdentity) => rpc(daemon.socket, { op: 'account.verify',
    account_id: account.id, expected_generation: account.generation, expected_identity: expected })
  const accountFiles = async (account: Account, email: string, accountId: string): Promise<void> => {
    await writeFile(join(account.native_home, 'auth.json'), '{"fixture":"synthetic-secret"}')
    await chmod(join(account.native_home, 'auth.json'), 0o600)
    await writeFile(join(account.native_home, 'identity.json'), JSON.stringify({ email, accountId }))
  }
  const snapshot = async (id: string) => (await rpc(daemon.socket, { op: 'conversation.get', conversation_id: id })).conversation as Conversation
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: daemon.rootDirectory })).workspace as { id: string }
    const first = (await rpc(daemon.socket, { op: 'account.create', provider: 'codex', name: 'One' })).account as Account
    const second = (await rpc(daemon.socket, { op: 'account.create', provider: 'codex', name: 'Two' })).account as Account
    expect(first.native_home).not.toBe(second.native_home)
    expect((await inspect(first.id)).inspection).toMatchObject({ state: 'unauthenticated', version: '0.157.0' })
    await accountFiles(first, 'one@example.invalid', 'workspace-one')
    await accountFiles(second, 'two@example.invalid', 'workspace-two')
    const firstIdentity = await identity(first.id)
    const secondIdentity = await identity(second.id)
    expect(firstIdentity).toEqual({ email: 'one@example.invalid', chatgpt_account_id: 'workspace-one' })
    expect(secondIdentity).toEqual({ email: 'two@example.invalid', chatgpt_account_id: 'workspace-two' })
    await writeFile(join(first.native_home, 'identity.json'), JSON.stringify({
      email: 'changed@example.invalid', accountId: 'workspace-changed',
    }))
    await expect(verify(first, firstIdentity)).rejects.toThrow(/identity changed since inspection/)
    expect(((await rpc(daemon.socket, { op: 'account.list' })).accounts as Account[])
      .find((account) => account.id === first.id)?.state).toBe('unverified')
    await writeFile(join(first.native_home, 'identity.json'), JSON.stringify({
      email: 'one@example.invalid', accountId: 'workspace-one',
    }))
    await expect(verify(first, secondIdentity)).rejects.toThrow(/identity changed since inspection/)
    expect((await verify(first, firstIdentity)).account).toMatchObject({ state: 'verified', codex_identity: firstIdentity })
    expect((await verify(second, secondIdentity)).account).toMatchObject({ state: 'verified', codex_identity: secondIdentity })

    const a = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', account_id: first.id })).conversation as Conversation
    const b = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', account_id: second.id })).conversation as Conversation
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: a.id, request_id: 'one-turn', text: 'hello one' })
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: b.id, request_id: 'two-turn', text: 'hello two' })
    await expect.poll(async () => (await snapshot(a.id)).status).toBe('ready')
    await expect.poll(async () => (await snapshot(b.id)).status).toBe('ready')
    expect((await snapshot(a.id)).provider_thread_id).toBeTruthy()
    expect((await snapshot(b.id)).provider_thread_id).toBeTruthy()
    for (const account of [first, second]) {
      expect(JSON.parse(await readFile(join(account.native_home, 'environment.json'), 'utf8'))).toMatchObject({
        codex_home: account.native_home, openai_key: false, codex_key: false, wif: false,
      })
    }
    const firstCalls = await readFile(join(first.native_home, 'calls.jsonl'), 'utf8')
    const secondCalls = await readFile(join(second.native_home, 'calls.jsonl'), 'utf8')
    expect(firstCalls).toContain('hello one')
    expect(firstCalls).not.toContain('hello two')
    expect(secondCalls).toContain('hello two')
    expect(secondCalls).not.toContain('hello one')
    expect(firstCalls + secondCalls).not.toContain('ambient-must-not-leak')
    expect(JSON.stringify(await inspect(first.id))).not.toContain('synthetic-secret')

    await writeFile(join(second.native_home, 'identity.json'), JSON.stringify({
      email: 'drifted@example.invalid', accountId: 'workspace-drifted',
    }))
    const beforeDrift = (await readFile(join(second.native_home, 'calls.jsonl'), 'utf8')).match(/"method": "turn\/start"/g)?.length ?? 0
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: b.id, request_id: 'drifted-turn', text: 'must reject drift' })
    await expect.poll(async () => (await snapshot(b.id)).error).toMatch(/identity changed before starting a turn/)
    expect((await readFile(join(second.native_home, 'calls.jsonl'), 'utf8')).match(/"method": "turn\/start"/g)?.length ?? 0)
      .toBe(beforeDrift)
    await writeFile(join(second.native_home, 'identity.json'), JSON.stringify({
      email: 'two@example.invalid', accountId: 'workspace-two',
    }))

    await rpc(daemon.socket, { op: 'agent.disconnect', conversation_id: a.id })
    await writeFile(join(first.native_home, 'identity.json'), JSON.stringify({ email: 'other@example.invalid', accountId: 'workspace-other' }))
    await rpc(daemon.socket, { op: 'agent.resume', conversation_id: a.id })
    await expect.poll(async () => (await snapshot(a.id)).error).toMatch(/identity changed/)
    expect((await snapshot(a.id)).provider_thread_id).toBeTruthy()

    await rm(cli)
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'missing_executable' })
    await writeFile(cli, await readFile(resolve('e2e/fixtures/codex_account_server.py')))
    await chmod(cli, 0o700)
    await writeFile(join(second.native_home, 'version'), 'codex-cli 0.158.0')
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'incompatible' })
    await rm(join(second.native_home, 'version'))
    await writeFile(join(second.native_home, 'no-routing'), '')
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'incompatible',
      reason: expect.stringMatching(/workspace routing/) })
    await rm(join(second.native_home, 'no-routing'))
    await writeFile(join(second.native_home, 'config-mode'), 'keyring')
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'incompatible' })
    await rm(join(second.native_home, 'config-mode'))
    await writeFile(join(second.native_home, 'gateway'), 'https://gateway.invalid/')
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'incompatible' })
    await rm(join(second.native_home, 'gateway'))
    await rm(join(second.native_home, 'auth.json'))
    expect((await inspect(second.id)).inspection).toMatchObject({ state: 'unauthenticated' })

    const linked = (await rpc(daemon.socket, { op: 'account.create', provider: 'codex', name: 'Linked files' })).account as Account
    await accountFiles(linked, 'linked@example.invalid', 'workspace-linked')
    await rm(join(linked.native_home, 'config.toml'))
    await link(join(first.native_home, 'config.toml'), join(linked.native_home, 'config.toml'))
    expect((await inspect(linked.id)).inspection).toMatchObject({ state: 'incompatible',
      reason: expect.stringMatching(/file configuration is unsafe/) })
    await rm(join(linked.native_home, 'config.toml'))
    await writeFile(join(linked.native_home, 'config.toml'), 'cli_auth_credentials_store = "file"\n')
    await chmod(join(linked.native_home, 'config.toml'), 0o600)
    await rm(join(linked.native_home, 'auth.json'))
    await link(join(first.native_home, 'auth.json'), join(linked.native_home, 'auth.json'))
    expect((await inspect(linked.id)).inspection).toMatchObject({ state: 'unauthenticated',
      reason: expect.stringMatching(/credentials are missing or unsafe/) })

    const live = (await rpc(daemon.socket, { op: 'account.create', provider: 'codex', name: 'Live disable' })).account as Account
    await accountFiles(live, 'live@example.invalid', 'workspace-live')
    await verify(live, await identity(live.id))
    const liveConversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', account_id: live.id })).conversation as Conversation
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: liveConversation.id,
      request_id: 'first-live-turn', text: 'first live turn' })
    await expect.poll(async () => (await snapshot(liveConversation.id)).status).toBe('ready')
    const beforeDisable = (await readFile(join(live.native_home, 'calls.jsonl'), 'utf8')).match(/"method": "turn\/start"/g)?.length ?? 0
    expect(beforeDisable).toBe(1)
    await rpc(daemon.socket, { op: 'account.disable', account_id: live.id })
    await expect(rpc(daemon.socket, { op: 'agent.send', conversation_id: liveConversation.id,
      request_id: 'disabled-turn', text: 'must reject disable' })).rejects.toThrow(/account is not verified/)
    await expect(rpc(daemon.socket, { op: 'agent.resume', conversation_id: liveConversation.id }))
      .rejects.toThrow(/account is not verified/)
    expect((await readFile(join(live.native_home, 'calls.jsonl'), 'utf8')).match(/"method": "turn\/start"/g)?.length ?? 0)
      .toBe(beforeDisable)

    const third = (await rpc(daemon.socket, { op: 'account.create', provider: 'codex', name: 'Late verify' })).account as Account
    await accountFiles(third, 'third@example.invalid', 'workspace-third')
    const thirdIdentity = await identity(third.id)
    await writeFile(join(third.native_home, 'delay'), '')
    const lateVerify = verify(third, thirdIdentity)
    await expect.poll(async () => readFile(join(third.native_home, 'probe-started'), 'utf8').catch(() => '')).toBe('yes')
    expect((await rpc(daemon.socket, { op: 'account.disable', account_id: third.id })).account).toMatchObject({
      state: 'disabled', generation: 1,
    })
    await writeFile(join(third.native_home, 'continue'), '')
    await expect(lateVerify).rejects.toThrow(/changed during verification/)

    const fourth = (await rpc(daemon.socket, { op: 'account.create', provider: 'codex', name: 'Late launch' })).account as Account
    await accountFiles(fourth, 'fourth@example.invalid', 'workspace-fourth')
    await verify(fourth, await identity(fourth.id))
    const c = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex', account_id: fourth.id })).conversation as Conversation
    await writeFile(join(fourth.native_home, 'delay'), '')
    await rpc(daemon.socket, { op: 'agent.send', conversation_id: c.id, request_id: 'must-not-run', text: 'must not run' })
    await expect.poll(async () => readFile(join(fourth.native_home, 'probe-started'), 'utf8').catch(() => '')).toBe('yes')
    await rpc(daemon.socket, { op: 'account.disable', account_id: fourth.id })
    await writeFile(join(fourth.native_home, 'continue'), '')
    await expect.poll(async () => (await snapshot(c.id)).error).toMatch(/Account changed before provider session opened/)
    expect((await snapshot(c.id)).provider_thread_id).toBeNull()
    expect(await readFile(join(fourth.native_home, 'calls.jsonl'), 'utf8')).not.toContain('thread/start')
  } finally {
    await daemon.stop()
    await rm(fixtures, { recursive: true, force: true })
  }
})
