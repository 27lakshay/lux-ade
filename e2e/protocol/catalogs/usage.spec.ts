// F049 and F030: usage and limits recorded from provider protocol events.
// The mocks' `usage` prompt reports fixture figures (Codex:
// thread/tokenUsage/updated and account/rateLimits/updated; Claude: result
// modelUsage and cost, and rate_limit_event). Every other prompt reports none.
import { expect, send, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'

const usagePrompt = 'usage'
const unpricedPrompt = 'usage-unpriced'
const farFutureMs = 4102444800 * 1000

async function call(profile: ScratchProfile, op: string, request: Record<string, unknown>): Promise<any> {
  return profile.call(op as never, request as never)
}

async function turn(profile: ScratchProfile, conversationId: string, text: string): Promise<void> {
  await send(profile, conversationId, text)
  await waitForIdle(profile, conversationId)
}

/** Wait until the conversation's finished turns are all recorded. */
async function recordedTurns(profile: ScratchProfile, conversationId: string, count: number): Promise<any[]> {
  let turns: any[] = []
  await expect.poll(async () => {
    turns = (await call(profile, 'usage.turns', { conversation_id: conversationId })).turns
    return turns.filter((entry) => entry.finished).length
  }).toBe(count)
  return turns
}

test('records Codex turns with provenance, marks cost and silent turns unavailable, and keeps the latest limits', async ({ profile }) => {
  const { conversationId, workspaceId } = await startConversation(profile, 'codex')
  await turn(profile, conversationId, usagePrompt)
  await turn(profile, conversationId, 'hello')
  await turn(profile, conversationId, usagePrompt)
  const turns = await recordedTurns(profile, conversationId, 3)

  const reported = turns.filter((entry) => entry.reported)
  expect(reported).toHaveLength(2)
  for (const entry of reported) {
    expect(entry).toMatchObject({ conversation_id: conversationId, workspace_id: workspaceId, provider: 'codex',
      account_id: null, source: 'thread/tokenUsage/updated', scope: 'main_agent',
      tokens: { input: 120, cached_input: 20, output: 30, reasoning: 5 }, cost_usd: null, cost_basis: null })
  }
  // A turn the provider said nothing about is unreported, never zero.
  expect(turns.find((entry) => !entry.reported)).toMatchObject({ tokens: { input: null, output: null }, cost_usd: null, source: null })

  const summary = await call(profile, 'usage.summary', { group_by: 'provider' })
  const codex = summary.groups.find((group: any) => group.key === 'codex')
  expect(codex).toMatchObject({ turns: 3, unreported_turns: 1,
    input: { value: 240, reported_turns: 2, unreported_turns: 1 },
    output: { value: 60, reported_turns: 2, unreported_turns: 1 },
    cost: { value_usd: null, reported_turns: 0, unreported_turns: 3 } })
  expect(summary.recording).toEqual({ dropped_batches: 0, last_error: null })

  const limits = await call(profile, 'usage.limits', { provider: 'codex' })
  expect(limits.windows).toEqual([expect.objectContaining({ provider: 'codex', account_id: null, limit_id: 'codex:primary',
    used_percent: 42, window_minutes: 300, resets_at: farFutureMs, plan: 'pro', source: 'account/rateLimits/updated',
    reset_since_observed: false })])
  expect(limits.windows[0].observed_at).toBeGreaterThan(0)
})

test('records Claude costs as agent estimates and omits a cost the agent could not price', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'claude')
  await turn(profile, conversationId, usagePrompt)
  await turn(profile, conversationId, usagePrompt)
  await turn(profile, conversationId, unpricedPrompt)
  await turn(profile, conversationId, 'hello')
  const turns = await recordedTurns(profile, conversationId, 4)
  const oldestFirst = [...turns].reverse()

  // Each turn is the difference of the query's running totals.
  for (const entry of oldestFirst.slice(0, 2)) {
    expect(entry).toMatchObject({ reported: true, source: 'result', scope: 'all_agents', cost_basis: 'agent_estimate',
      models: ['claude-fixture'], tokens: { input: 130, cached_input: 100, cache_write: 20, output: 5 } })
    expect(entry.cost_usd).toBeCloseTo(0.5)
  }
  expect(oldestFirst[2]).toMatchObject({ reported: true, cost_usd: null, cost_basis: null, tokens: { input: 130, output: 5 } })
  expect(oldestFirst[2].note).toMatch(/no price/)
  expect(oldestFirst[3]).toMatchObject({ reported: false, cost_usd: null })

  const summary = await call(profile, 'usage.summary', { group_by: 'conversation', conversation_id: conversationId })
  expect(summary.total).toMatchObject({ turns: 4, unreported_turns: 1,
    input: { value: 390, reported_turns: 3, unreported_turns: 1 },
    cost: { basis: ['agent_estimate'], reported_turns: 2, unreported_turns: 2 } })
  expect(summary.total.cost.value_usd).toBeCloseTo(1.0)

  const limits = await call(profile, 'usage.limits', { provider: 'claude' })
  expect(limits.windows).toEqual([expect.objectContaining({ limit_id: 'five_hour', used_percent: 25,
    resets_at: farFutureMs, status: 'allowed_warning', source: 'rate_limit_event' })])
})

test('aggregates across providers by workspace, account and day', async ({ profile }) => {
  const codex = await startConversation(profile, 'codex')
  const claude = await startConversation(profile, 'claude')
  await turn(profile, codex.conversationId, usagePrompt)
  await turn(profile, claude.conversationId, usagePrompt)
  await recordedTurns(profile, codex.conversationId, 1)
  await recordedTurns(profile, claude.conversationId, 1)

  const byProvider = await call(profile, 'usage.summary', { group_by: 'provider' })
  expect(byProvider.groups.map((group: any) => group.key).sort()).toEqual(['claude', 'codex'])
  // Codex reports no cost, so the combined cost is partial and says so.
  expect(byProvider.total).toMatchObject({ turns: 2, input: { value: 250, reported_turns: 2 },
    cost: { reported_turns: 1, unreported_turns: 1 }, scopes: expect.arrayContaining(['main_agent', 'all_agents']) })

  const byWorkspace = await call(profile, 'usage.summary', { group_by: 'workspace' })
  expect(byWorkspace.groups).toEqual([expect.objectContaining({ key: codex.workspaceId, turns: 2 })])

  const byAccount = await call(profile, 'usage.summary', { group_by: 'account' })
  expect(byAccount.groups).toEqual([expect.objectContaining({ key: null, turns: 2 })])

  const byDay = await call(profile, 'usage.summary', { group_by: 'day', utc_offset_minutes: 0 })
  expect(byDay.groups).toHaveLength(1)
  expect(byDay.groups[0].key).toBe(new Date().toISOString().slice(0, 10))

  const cli = await profile.cli('usage', 'summary', '--by', 'provider')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'usage_summary', group_by: 'provider' })
  const onlyClaude = await call(profile, 'usage.summary', { group_by: 'provider', provider: 'claude' })
  expect(onlyClaude.groups.map((group: any) => group.key)).toEqual(['claude'])
})

test('a daemon crash and restart neither loses nor double-counts recorded usage', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'codex')
  await turn(profile, conversationId, usagePrompt)
  await recordedTurns(profile, conversationId, 1)
  const before = await call(profile, 'usage.summary', { group_by: 'conversation' })

  await profile.restartDaemon('kill')
  expect((await call(profile, 'usage.summary', { group_by: 'conversation' })).total).toEqual(before.total)

  // The runtime replays the run's events to the new daemon; the next turn adds exactly one more.
  await turn(profile, conversationId, usagePrompt)
  const turns = await recordedTurns(profile, conversationId, 2)
  expect(turns.filter((entry) => entry.reported)).toHaveLength(2)
  const after = await call(profile, 'usage.summary', { group_by: 'conversation' })
  expect(after.total).toMatchObject({ turns: 2, input: { value: 240, reported_turns: 2 }, output: { value: 60 } })
  expect((await call(profile, 'usage.limits', {})).windows).toHaveLength(1)

  // A crash while a turn's events may still be in flight: the runtime replays
  // them to the next daemon, and the usage cursor skips what was already saved.
  await send(profile, conversationId, usagePrompt)
  await profile.restartDaemon('kill')
  await waitForIdle(profile, conversationId)
  await recordedTurns(profile, conversationId, 3)
  const replayed = await call(profile, 'usage.summary', { group_by: 'conversation' })
  expect(replayed.total).toMatchObject({ turns: 3, unreported_turns: 0, input: { value: 360, reported_turns: 3 } })
})

test('refuses malformed usage queries instead of answering partially', async ({ profile }) => {
  await expect(call(profile, 'usage.turns', { cursor: 'not-a-cursor' })).rejects.toThrow()
  await expect(profile.rpc({ op: 'usage.summary', group_by: 'day', utc_offset_minutes: 5000 })).rejects.toThrow()
})

// F030 also asks that exhaustion never silently switch account or model. The
// mocks cannot report an exhausted limit that blocks a turn, and no ADE
// behaviour reacts to a `rejected` limit status yet, so that half is unproven.
test.fixme('an exhausted limit is shown and does not switch account or model', async ({ profile }) => {
  const { conversationId } = await startConversation(profile, 'claude')
  await turn(profile, conversationId, 'usage-exhausted')
  const limits = await call(profile, 'usage.limits', { provider: 'claude' })
  expect(limits.windows[0].status).toBe('rejected')
})
