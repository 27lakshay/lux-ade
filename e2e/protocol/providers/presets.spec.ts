// F029 and F028: presets are validated against the provider's current
// capability record when saved, rechecked on every read, and applied to a new
// Conversation only while they still fit. A conflict is reported, never
// silently adapted, and a preset never selects an account.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, send, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { conversationOn, profileWithClis, record, verifiedAccount } from './steps'

/**
 * Rewrite a stored preset as an earlier ADE build would have saved it: against
 * another capability revision or fingerprint, with a setting that build's
 * adapter allowed. Only the stored row changes; the daemon reads it on the next query.
 */
function storeAsEarlierBuild(
  profile: ScratchProfile,
  name: string,
  change: (preset: Record<string, any>) => void,
): void {
  const db = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('SELECT data FROM provider_presets WHERE name = ?').get(name) as { data: string }
    const preset = JSON.parse(row.data) as Record<string, any>
    change(preset)
    db.prepare('UPDATE provider_presets SET data = ? WHERE name = ?').run(JSON.stringify(preset), name)
  } finally {
    db.close()
  }
}

test('F029: a preset is created, converges on repeat, is replaced and deleted only at the revision the caller saw, and survives a restart', async ({
  profile,
}) => {
  const codex = await record(profile, 'codex')
  const saved = await profile.call('preset.save', {
    name: '  Careful  ',
    provider: 'codex',
    model: 'gpt-fixture',
    permission_mode: 'read-only',
  })
  expect(saved).toMatchObject({
    changed: true,
    preset: {
      name: 'Careful',
      revision: 1,
      settings: { provider: 'codex', model: 'gpt-fixture', reasoning: null, permission_mode: 'read-only' },
      capability_revision: codex.revision,
      capability_fingerprint: codex.fingerprint,
    },
  })
  expect(saved.preset).not.toHaveProperty('account_id')

  // The same settings again change nothing; a create over an existing preset is refused.
  const again = await profile.call('preset.save', {
    name: 'Careful',
    provider: 'codex',
    model: 'gpt-fixture',
    permission_mode: 'read-only',
  })
  expect(again).toMatchObject({ changed: false, preset: { revision: 1 } })
  await expect(profile.call('preset.save', { name: 'Careful', provider: 'codex', model: 'other' })).rejects.toThrow(
    /already exists at revision 1/,
  )

  const replaced = await profile.call('preset.save', {
    name: 'Careful',
    provider: 'codex',
    model: 'gpt-fixture-2',
    permission_mode: 'read-only',
    expected_revision: 1,
  })
  expect(replaced).toMatchObject({ changed: true, preset: { revision: 2, settings: { model: 'gpt-fixture-2' } } })
  // A writer that saw revision 1 cannot overwrite revision 2.
  await expect(
    profile.call('preset.save', { name: 'Careful', provider: 'codex', model: 'stale', expected_revision: 1 }),
  ).rejects.toThrow(/changed to revision 2/)
  await expect(
    profile.call('preset.save', { name: 'Missing', provider: 'codex', expected_revision: 1 }),
  ).rejects.toThrow(/no longer exists/)

  const view = await profile.call('preset.get', { name: 'Careful' })
  expect(view).toMatchObject({ capability_change: 'unchanged', conflicts: [], preset: { revision: 2 } })

  await profile.restartDaemon('kill')
  const listed = await profile.call('preset.list', {})
  expect(listed.presets).toEqual([
    expect.objectContaining({
      capability_change: 'unchanged',
      conflicts: [],
      preset: expect.objectContaining({ name: 'Careful', revision: 2 }),
    }),
  ])

  await expect(profile.call('preset.delete', { name: 'Careful', expected_revision: 1 })).rejects.toThrow(
    /changed to revision 2/,
  )
  expect(await profile.call('preset.delete', { name: 'Careful', expected_revision: 2 })).toMatchObject({
    deleted: true,
  })
  // Deleting again converges.
  expect(await profile.call('preset.delete', { name: 'Careful', expected_revision: 2 })).toMatchObject({
    deleted: false,
  })
  expect((await profile.call('preset.list', {})).presets).toEqual([])
  await expect(profile.call('preset.get', { name: 'Careful' })).rejects.toThrow(/No preset is named Careful/)
})

test('F029: saving a setting the current record does not support is refused with the reason, and nothing is stored', async ({
  profile,
}) => {
  const codex = await record(profile, 'codex')
  expect(codex.reasoning.selection.support).toBe('native_only')
  await expect(profile.call('preset.save', { name: 'Deep', provider: 'codex', reasoning: 'high' })).rejects.toThrow(
    /reasoning selection is unavailable/,
  )
  await expect(
    profile.call('preset.save', { name: 'Open', provider: 'codex', permission_mode: 'danger-full-access' }),
  ).rejects.toThrow(/permission mode danger-full-access is unavailable/)
  await expect(
    profile.call('preset.save', { name: 'Odd', provider: 'codex', permission_mode: 'no-such-mode' }),
  ).rejects.toThrow(/has no permission mode no-such-mode/)
  // OpenCode needs a provider-qualified model ID.
  await expect(profile.call('preset.save', { name: 'Bare', provider: 'opencode', model: 'sonnet' })).rejects.toThrow(
    /provider\/model ID/,
  )
  await expect(profile.call('preset.save', { name: 'Nowhere', provider: 'no-such-provider' })).rejects.toThrow(
    /Unknown provider/,
  )
  await expect(profile.call('preset.save', { name: '   ', provider: 'codex' })).rejects.toThrow(/Missing name/)
  expect((await profile.call('preset.list', {})).presets).toEqual([])

  const cli = await profile.cli('preset', 'save', 'Deep', '--provider', 'codex', '--reasoning', 'high')
  expect(cli.code).not.toBe(0)
  expect(cli.stderr).toMatch(/reasoning selection is unavailable/)
})

test('F029: applying a preset shows the resolved settings, launches with them and leaves the account as chosen', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  await profile.call('preset.save', {
    name: 'Reviewer',
    provider: 'codex',
    model: 'gpt-fixture',
    permission_mode: 'read-only',
  })

  // Without an account the Conversation stays on the provider's own login.
  const ambient = await conversationOn(profile, 'codex', undefined, { preset: 'Reviewer' })
  expect(ambient.conversation).toMatchObject({
    provider: 'codex',
    account_id: null,
    provider_config: { model: 'gpt-fixture', permission_mode: 'read-only' },
  })

  // With a managed account, that account is kept; the preset carries none.
  const account = await verifiedAccount(profile, clis, 'codex', 'Work', {
    email: 'w@example.invalid',
    account_id: 'org-w',
  })
  const managed = await conversationOn(profile, 'codex', account.id, { preset: 'Reviewer' })
  expect(managed.conversation).toMatchObject({
    account_id: account.id,
    provider_config: { model: 'gpt-fixture', permission_mode: 'read-only' },
  })
  await send(profile, managed.conversationId, 'hello')
  await waitForIdle(profile, managed.conversationId)
  const started = (await clis.codexCalls()).filter((call) => call.method === 'thread/start')
  expect(started.at(-1)!.params).toMatchObject({ model: 'gpt-fixture', sandbox: 'read-only' })
  const launches = await clis.codexLaunches()
  expect(launches.at(-1)!.codex_home).toBe(account.native_home)
  expect(
    (await profile.call('account.list', {})).accounts.find((candidate) => candidate.id === account.id),
  ).toMatchObject({ generation: account.generation, state: 'verified' })

  // A preset names its provider: omitting the provider takes it, a different one is refused.
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const implied = await profile.call('conversation.create', { workspace_id: workspace.id, preset: 'Reviewer' })
  expect(implied.conversation.provider).toBe('codex')
  await expect(
    profile.call('conversation.create', { workspace_id: workspace.id, provider: 'claude', preset: 'Reviewer' }),
  ).rejects.toThrow(/Preset Reviewer is for codex, not claude/)
  await expect(
    profile.call('conversation.create', {
      workspace_id: workspace.id,
      preset: 'Reviewer',
      provider_config: { permission_mode: 'default' },
    }),
  ).rejects.toThrow(/either a preset or provider settings/)
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, preset: 'Nobody' })).rejects.toThrow(
    /No preset is named Nobody/,
  )

  // The CLI applies the preset the same way.
  const cli = await profile.cli('conversation', 'create', workspace.id, '--preset', 'Reviewer')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({
    conversation: { provider: 'codex', provider_config: { model: 'gpt-fixture', permission_mode: 'read-only' } },
  })
})

test('F029 and F028: after a capability revision a stale preset reports its conflict and is refused, not adapted', async ({
  profile,
}) => {
  const codex = await record(profile, 'codex')
  await profile.call('preset.save', { name: 'Legacy', provider: 'codex', permission_mode: 'read-only' })
  await profile.call('preset.save', { name: 'Drifted', provider: 'codex', model: 'gpt-fixture' })

  // "Legacy" was saved by an earlier build whose Codex record offered full access.
  storeAsEarlierBuild(profile, 'Legacy', (preset) => {
    preset.capability_revision = codex.revision - 1
    preset.capability_fingerprint = 'an-earlier-record'
    preset.settings.permission_mode = 'danger-full-access'
  })
  // "Drifted" carries the current revision but another fingerprint.
  storeAsEarlierBuild(profile, 'Drifted', (preset) => {
    preset.capability_fingerprint = 'not-this-record'
  })

  const legacy = await profile.call('preset.get', { name: 'Legacy' })
  expect(legacy.capability_change).toBe('revised')
  expect(legacy.conflicts).toEqual([
    { field: 'permission_mode', message: expect.stringMatching(/permission mode danger-full-access is unavailable/) },
  ])
  // The stored settings are reported as saved, not rewritten to something that fits.
  expect(legacy.preset.settings.permission_mode).toBe('danger-full-access')
  const drifted = await profile.call('preset.get', { name: 'Drifted' })
  expect(drifted).toMatchObject({ capability_change: 'drifted', conflicts: [] })

  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  await expect(profile.call('conversation.create', { workspace_id: workspace.id, preset: 'Legacy' })).rejects.toThrow(
    /Preset Legacy conflicts with the current codex capabilities: .*danger-full-access/,
  )
  // A drifted record with no conflict still applies.
  expect(
    (await profile.call('conversation.create', { workspace_id: workspace.id, preset: 'Drifted' })).conversation
      .provider_config,
  ).toMatchObject({ model: 'gpt-fixture' })

  const listed = await profile.call('preset.list', {})
  expect(listed.presets.map((entry) => [entry.preset.name, entry.capability_change, entry.conflicts.length])).toEqual([
    ['Drifted', 'drifted', 0],
    ['Legacy', 'revised', 1],
  ])
  const cli = await profile.cli('preset', 'show', 'Legacy')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({
    type: 'preset',
    capability_change: 'revised',
    conflicts: [{ field: 'permission_mode' }],
  })

  // Resaving it under the current record clears the conflict at a new revision.
  const fixed = await profile.call('preset.save', {
    name: 'Legacy',
    provider: 'codex',
    permission_mode: 'read-only',
    expected_revision: legacy.preset.revision,
  })
  expect(fixed.preset).toMatchObject({
    revision: legacy.preset.revision + 1,
    capability_revision: codex.revision,
    capability_fingerprint: codex.fingerprint,
  })
  expect(await profile.call('preset.get', { name: 'Legacy' })).toMatchObject({
    capability_change: 'unchanged',
    conflicts: [],
  })
})
