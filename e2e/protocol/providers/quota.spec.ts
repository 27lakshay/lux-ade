// F030: quota and limit visibility from the limits providers report during
// turns. Each entry carries its source and freshness; a provider that does
// not report limits is unavailable; exhaustion is shown and never answered by
// switching account or model.
import { expect, send, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { conversationOn, profileWithClis, verifiedAccount } from './steps'

const farFutureMs = 4102444800 * 1000

async function quota(profile: ScratchProfile, request: { provider?: string; account_id?: string } = {}) {
  return profile.call('provider.quota', request)
}

async function turn(profile: ScratchProfile, conversationId: string, text: string): Promise<void> {
  await send(profile, conversationId, text)
  await waitForIdle(profile, conversationId)
}

test('F030: before any report every provider and account says not reported or unavailable, never zero', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const account = await verifiedAccount(profile, clis, 'codex', 'Work', {
    email: 'w@example.invalid',
    account_id: 'org-w',
  })
  const { entries, recording } = await quota(profile)
  expect(recording).toEqual({ dropped_batches: 0, last_error: null })
  const key = (entry: { provider: string; account_id: string | null }) =>
    `${entry.provider}:${entry.account_id ?? 'own'}`
  expect(entries.map(key).sort()).toEqual(['claude:own', 'codex:own', `codex:${account.id}`, 'omp:own'].sort())
  for (const entry of entries) {
    expect(entry).toMatchObject({ windows: [], exhausted: false, observed_at: null, age_ms: null })
    expect(entry.reason).not.toBe('')
  }
  for (const provider of ['codex', 'claude']) {
    expect(entries.filter((entry) => entry.provider === provider).map((entry) => entry.state)).toEqual(
      expect.arrayContaining(['not_reported']),
    )
  }
  // Oh My Pi has not been confirmed to report limits.
  for (const provider of ['omp']) {
    const entry = entries.find((candidate) => candidate.provider === provider)!
    expect(entry.state).toBe('unavailable')
    expect(entry.reason).toMatch(/limits are unavailable/)
  }
  await expect(quota(profile, { provider: 'no-such-provider' })).rejects.toThrow(/Unknown provider/)
  await expect(quota(profile, { provider: 'claude', account_id: account.id })).rejects.toThrow(/another provider/)
})

test('F030: a managed account shows the limits its turns reported, with source and age, apart from other accounts', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const work = await verifiedAccount(profile, clis, 'codex', 'Work', {
    email: 'w@example.invalid',
    account_id: 'org-w',
  })
  const spare = await verifiedAccount(profile, clis, 'codex', 'Spare', {
    email: 's@example.invalid',
    account_id: 'org-s',
  })
  const { conversationId } = await conversationOn(profile, 'codex', work.id)
  await turn(profile, conversationId, 'usage')

  let reported: Awaited<ReturnType<typeof quota>>['entries'][number] | undefined
  await expect
    .poll(async () => {
      reported = (await quota(profile, { account_id: work.id })).entries[0]
      return reported?.state
    })
    .toBe('reported')
  expect(reported).toMatchObject({
    provider: 'codex',
    account_id: work.id,
    exhausted: false,
    windows: [
      expect.objectContaining({
        provider: 'codex',
        account_id: work.id,
        source: 'account/rateLimits/updated',
        used_percent: 42,
        window_minutes: 300,
        resets_at: farFutureMs,
        plan: 'pro',
        reset_since_observed: false,
      }),
    ],
  })
  expect(reported!.reason).toMatch(/last reported/)
  expect(reported!.observed_at).toBe(reported!.windows[0].observed_at)
  expect(reported!.age_ms).toBeGreaterThanOrEqual(0)

  // The report belongs to the account that ran the turn, not to its neighbours.
  const all = (await quota(profile, { provider: 'codex' })).entries
  expect(all.find((entry) => entry.account_id === spare.id)).toMatchObject({ state: 'not_reported', windows: [] })
  expect(all.find((entry) => entry.account_id === null)).toMatchObject({ state: 'not_reported' })

  // Freshness is measured against the report, so a later query shows an older age.
  const first = reported!.age_ms!
  await expect
    .poll(async () => (await quota(profile, { account_id: work.id })).entries[0].age_ms!)
    .toBeGreaterThan(first)

  // A daemon crash keeps the recorded limits.
  await profile.restartDaemon('kill')
  expect((await quota(profile, { account_id: work.id })).entries[0]).toMatchObject({
    state: 'reported',
    observed_at: reported!.observed_at,
  })

  const cli = await profile.cli('provider', 'quota', '--account', work.id)
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'provider_quota', entries: [{ account_id: work.id, state: 'reported' }] })
})

test('F030: an exhausted limit is shown, and the next turn stays on the same account and model', async ({ ade }) => {
  const { profile, clis } = await profileWithClis(ade)
  const work = await verifiedAccount(profile, clis, 'codex', 'Work', {
    email: 'w@example.invalid',
    account_id: 'org-w',
  })
  await verifiedAccount(profile, clis, 'codex', 'Spare', { email: 's@example.invalid', account_id: 'org-s' })
  const { conversationId } = await conversationOn(profile, 'codex', work.id, {
    provider_config: { model: 'gpt-fixture', permission_mode: 'default' },
  })
  // Launches from here on are this conversation's, including each launch's account probe.
  const earlier = (await clis.codexLaunches()).length
  await clis.exhaustCodexLimits()
  await turn(profile, conversationId, 'usage')
  await expect.poll(async () => (await quota(profile, { account_id: work.id })).entries[0]?.exhausted).toBe(true)
  expect((await quota(profile, { account_id: work.id })).entries[0].windows[0]).toMatchObject({ used_percent: 100 })

  // ADE keeps using what the user chose; it does not fall back to the spare account or another model.
  await turn(profile, conversationId, 'hello')
  const conversation = (await profile.call('conversation.get', { conversation_id: conversationId })).conversation
  expect(conversation).toMatchObject({ account_id: work.id, provider_config: { model: 'gpt-fixture' } })
  expect((await profile.call('account.switch.list', { conversation_id: conversationId })).switches).toEqual([])
  const launches = (await clis.codexLaunches()).slice(earlier)
  expect(new Set(launches.map((launch) => launch.codex_home))).toEqual(new Set([work.native_home]))
  const turns = (await clis.codexCalls()).filter((call) => call.method === 'turn/start')
  expect(turns).toHaveLength(2)
  expect(
    (await clis.codexCalls())
      .filter((call) => call.method === 'thread/start')
      .map((call) => (call.params as any).model),
  ).toEqual(['gpt-fixture'])
})
