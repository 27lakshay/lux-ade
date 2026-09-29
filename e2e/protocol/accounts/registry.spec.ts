// F026 managed accounts: each account gets its own durable home inside its
// profile, conversations keep the account they were created with across a
// restart, a redirected home is refused, and an unverified account never falls
// back to ambient credentials. Ported from the legacy e2e/specs/account-registry
// and account-launch specs; the profile registry is ade-control's.
import { access, chmod, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test as scratchTest } from '../fixtures'
import { expect, test, type ManagedProfile } from '../fixtures/managed-profiles'

async function started(profile: ManagedProfile): Promise<string> {
  const status = await profile.cli('status')
  expect(status.code, status.stderr).toBe(0)
  return (await profile.call('catalog.get', {})).catalog.workspaces[0]!.id
}

test('accounts have durable, distinct profile homes and conversations keep their account', async ({ host }) => {
  const profile = await host.create('Work')
  const workspace_id = await started(profile)

  const first = (await profile.call('account.create', { provider: 'codex', name: 'Personal' })).account
  const second = (await profile.call('account.create', { provider: 'codex', name: 'Team' })).account
  expect(first).toMatchObject({ provider: 'codex', name: 'Personal', generation: 0, state: 'unverified' })
  expect(second).toMatchObject({ provider: 'codex', name: 'Team', generation: 0, state: 'unverified' })
  expect(first.id).not.toBe(second.id)
  expect(first.native_home).not.toBe(second.native_home)
  for (const account of [first, second]) {
    expect(account.native_home).toContain(profile.id)
    await access(account.native_home)
    expect((await stat(account.native_home)).mode & 0o777).toBe(0o700)
  }
  expect((await profile.call('account.list', {})).accounts).toEqual([first, second])

  // An account of another provider, an unknown account and a null account are refused.
  await expect(
    profile.call('conversation.create', {
      workspace_id,
      provider: 'claude',
      account_id: first.id,
      title: 'Wrong provider',
    }),
  ).rejects.toThrow(/another provider/)
  await expect(
    profile.call('conversation.create', {
      workspace_id,
      provider: 'codex',
      account_id: 'missing-account',
      title: 'Missing account',
    }),
  ).rejects.toThrow()
  await expect(
    profile.rpc({
      op: 'conversation.create',
      operation_id: 'create-null-account',
      workspace_id,
      provider: 'codex',
      account_id: null,
      title: 'Invalid account',
    }),
  ).rejects.toThrow(/Invalid account ID/)

  const create = async (title: string, account_id?: string) =>
    (
      await profile.call('conversation.create', {
        workspace_id,
        provider: 'codex',
        title,
        ...(account_id ? { account_id } : {}),
      })
    ).conversation
  const firstConversation = await create('Personal turn', first.id)
  const secondConversation = await create('Team turn', second.id)
  const ambient = await create('Earlier behavior')
  expect(firstConversation).toMatchObject({ account_id: first.id, account_context: 'managed' })
  expect(secondConversation).toMatchObject({ account_id: second.id, account_context: 'managed' })
  expect(ambient).toMatchObject({ account_id: null, account_context: 'legacy_ambient' })

  await profile.stop()
  await started(profile)
  expect((await profile.call('account.list', {})).accounts).toEqual([first, second])
  for (const [conversation, expected] of [
    [firstConversation, first.id],
    [secondConversation, second.id],
    [ambient, null],
  ] as const) {
    expect((await profile.call('conversation.get', { conversation_id: conversation.id })).conversation).toMatchObject({
      id: conversation.id,
      account_id: expected,
      account_context: expected ? 'managed' : 'legacy_ambient',
    })
  }

  // A home replaced by a link to another account's home is refused, not followed.
  await rename(first.native_home, `${first.native_home}-saved`)
  await symlink(second.native_home, first.native_home)
  await expect(profile.call('account.list', {})).rejects.toThrow(/redirected/)
})

scratchTest('an unverified managed account cannot fall back to ambient Claude credentials', async ({ ade }) => {
  const launcher = join(ade.root, 'claude-bridge')
  const launched = join(ade.root, 'launched')
  await writeFile(launcher, `#!/bin/sh\ntouch ${JSON.stringify(launched)}\nexit 1\n`)
  await chmod(launcher, 0o700)
  const profile = await ade.profile({ env: { ADE_CLAUDE_BRIDGE_BIN: launcher, ANTHROPIC_API_KEY: 'ambient-token' } })
  const workspace_id = (await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })).workspace.id
  const account = (await profile.call('account.create', { provider: 'claude', name: 'Other account' })).account
  expect(account.state).toBe('unverified')
  const conversation = (
    await profile.call('conversation.create', { workspace_id, provider: 'claude', account_id: account.id })
  ).conversation
  await expect(
    profile.call('agent.send', {
      conversation_id: conversation.id,
      request_id: 'managed-attempt',
      text: 'Use the selected account',
    }),
  ).rejects.toThrow(/account is not verified/)
  // The provider was never launched.
  await expect(access(launched)).rejects.toThrow()
  const snapshot = await profile.call('conversation.get', { conversation_id: conversation.id })
  expect(snapshot.conversation).toMatchObject({ account_id: account.id })
  expect(snapshot.messages).toEqual([])
})
