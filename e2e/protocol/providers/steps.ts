// Steps the provider specs share: a profile whose provider executables are the
// scripted CLIs, and managed accounts signed in and verified through the
// public account operations. Every wait polls a query; none sleeps.
import { expect, type AdeHarness, type ScratchProfile } from '../fixtures'
import { FakeProviderClis, type FakeCliProvider, type FixtureIdentity } from '../fixtures/provider-cli'

export type Account = { id: string; provider: string; name: string; native_home: string; generation: number; state: string }

/** A profile that launches and checks providers through the scripted CLIs. */
export async function profileWithClis(ade: AdeHarness): Promise<{ profile: ScratchProfile; clis: FakeProviderClis }> {
  const clis = await FakeProviderClis.create(ade)
  const profile = await ade.profile({ env: clis.env })
  return { profile, clis }
}

export async function readiness(profile: ScratchProfile, provider: string, accountId?: string) {
  return profile.call('provider.readiness', { provider, ...(accountId ? { account_id: accountId } : {}) })
}

type Readiness = Awaited<ReturnType<typeof readiness>>

/**
 * Poll readiness until it matches `expected` and return that verdict. The
 * account probes have a two-second budget, so on a heavily loaded host one
 * probe can report `unavailable`; a verdict is a snapshot, and the next query
 * checks again.
 */
export async function readinessBecomes(profile: ScratchProfile, provider: string, accountId: string | undefined,
  expected: Partial<Record<keyof Readiness, unknown>>): Promise<Readiness> {
  let last: Readiness | undefined
  await expect.poll(async () => (last = await readiness(profile, provider, accountId)), { timeout: 20_000 })
    .toMatchObject(expected)
  return last!
}

/** Create a managed account, sign its home in as `identity`, inspect it and pin that identity. */
export async function verifiedAccount(profile: ScratchProfile, clis: FakeProviderClis, provider: FakeCliProvider,
  name: string, identity: FixtureIdentity): Promise<Account> {
  const { account } = await profile.call('account.create', { provider, name })
  await clis.signIn(provider, account.native_home, identity)
  return verify(profile, account.id)
}

/** Inspect a signed-in account and pin the identity the inspection read. */
export async function verify(profile: ScratchProfile, accountId: string): Promise<Account> {
  // Both steps run the provider probe; one that timed out on a loaded host is retried.
  let verified: Account | undefined
  await expect(async () => {
    const inspected = await profile.call('account.inspect', { account_id: accountId })
    expect(inspected.inspection.state, inspected.inspection.reason).toBe('ready')
    verified = (await profile.call('account.verify', { account_id: accountId,
      expected_generation: inspected.generation, expected_identity: inspected.inspection.identity })).account as Account
  }).toPass({ timeout: 20_000 })
  expect(verified!.state).toBe('verified')
  return verified!
}

/** The capability record `provider` currently declares. */
export async function record(profile: ScratchProfile, provider: string) {
  const { providers } = await profile.call('provider.capabilities', { provider })
  expect(providers).toHaveLength(1)
  return providers[0]!
}

/** A conversation in the profile's default workspace, on a managed account when one is given. */
export async function conversationOn(profile: ScratchProfile, provider: string, accountId?: string,
  extra: { preset?: string; provider_config?: Record<string, unknown> } = {}) {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const { conversation } = await profile.call('conversation.create', { workspace_id: workspace.id, provider,
    ...(accountId ? { account_id: accountId } : {}), ...extra })
  return { workspaceId: workspace.id, conversationId: conversation.id, conversation }
}
