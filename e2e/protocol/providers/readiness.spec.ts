// F027: provider setup, authentication and readiness. The scripted CLIs stand
// in for installed provider executables: a spec uninstalls one, or replaces it
// with another version, the way an external update would, and each readiness
// query checks again rather than trusting an earlier verdict.
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, send, test, waitForIdle } from '../fixtures'
import { compatibleVersions, FakeProviderClis } from '../fixtures/provider-cli'
import { conversationOn, profileWithClis, readiness, readinessBecomes, record, verifiedAccount, verify } from './steps'

test('F027: Codex readiness walks missing credentials, verification, ready, an external uninstall and an incompatible update, and revalidates each time', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const codex = await record(profile, 'codex')

  // Without an account ADE checks installation only and never claims ready.
  const installed = await readiness(profile, 'codex')
  expect(installed).toMatchObject({
    provider: 'codex',
    account_id: null,
    state: 'installed_unchecked',
    version: null,
    capability_revision: codex.revision,
  })
  expect(installed.reason).toMatch(/pass an account/)
  expect(installed.checks).toContainEqual({
    check: 'executable:codex',
    state: 'passed',
    detail: await realpath(clis.path('codex')),
  })
  // Profiles use the stdio transport, so Bun, which only the shared transport runs, is not required.
  expect(installed.checks).toContainEqual({
    check: 'runtime:bun',
    state: 'skipped',
    detail: expect.stringMatching(/Not used/),
  })

  const { account } = await profile.call('account.create', { provider: 'codex', name: 'Work' })
  const signedOut = await readinessBecomes(profile, 'codex', account.id, {
    account_id: account.id,
    state: 'needs_authentication',
    version: compatibleVersions.codex,
  })
  expect(signedOut.reason).toMatch(/Sign in with the Codex CLI/)
  expect(signedOut.checks).toContainEqual(expect.objectContaining({ check: 'account', state: 'failed' }))

  await clis.invalidateCredentials('codex', account.native_home)
  await readinessBecomes(profile, 'codex', account.id, {
    state: 'needs_authentication',
    version: compatibleVersions.codex,
  })

  await clis.signIn('codex', account.native_home, { email: 'work@example.invalid', account_id: 'org-work' })
  const unverified = await readinessBecomes(profile, 'codex', account.id, { state: 'needs_verification' })
  expect(unverified.reason).toMatch(/account verify/)

  await verify(profile, account.id)
  const ready = await readinessBecomes(profile, 'codex', account.id, {
    state: 'ready',
    version: compatibleVersions.codex,
  })
  expect(ready.checks).toContainEqual(expect.objectContaining({ check: 'account', state: 'passed' }))

  // A conversation launches under the ready account.
  const { conversationId } = await conversationOn(profile, 'codex', account.id)
  await send(profile, conversationId, 'hello')
  await waitForIdle(profile, conversationId)

  // The CLI is uninstalled behind ADE's back.
  await clis.uninstall('codex')
  const missing = await readiness(profile, 'codex', account.id)
  expect(missing.state).toBe('missing_executable')
  expect(missing.reason).toMatch(/ADE_CODEX_BIN/)
  expect(missing.checks).toContainEqual(expect.objectContaining({ check: 'executable:codex', state: 'failed' }))

  // An update installs a build outside the validated range.
  await clis.install('codex', '0.158.0')
  const incompatible = await readinessBecomes(profile, 'codex', account.id, {
    state: 'incompatible',
    version: '0.158.0',
  })
  expect(incompatible.reason).toMatch(/outside the validated 0\.157\.0 build/)
  // A launch checks again and refuses with the same actionable reason.
  await profile.call('agent.disconnect', { conversation_id: conversationId })
  await profile.call('agent.resume', { conversation_id: conversationId })
  await expect
    .poll(async () => (await profile.call('conversation.get', { conversation_id: conversationId })).conversation)
    .toMatchObject({ status: 'error', error: expect.stringMatching(/outside the validated 0\.157\.0 build/) })

  // Reinstalling the validated build makes the same account ready again.
  await clis.install('codex', compatibleVersions.codex)
  await readinessBecomes(profile, 'codex', account.id, { state: 'ready' })

  // Signing the home in as someone else is reported, not accepted.
  await clis.signIn('codex', account.native_home, { email: 'other@example.invalid', account_id: 'org-other' })
  const changed = await readinessBecomes(profile, 'codex', account.id, { state: 'identity_changed' })
  expect(changed.reason).toMatch(/verify the account again/)

  await profile.call('account.disable', { account_id: account.id })
  const disabled = await readiness(profile, 'codex', account.id)
  expect(disabled.state).toBe('account_disabled')
  expect(disabled.checks).toContainEqual(expect.objectContaining({ check: 'account', state: 'skipped' }))

  // The CLI reports the same verdicts.
  const cli = await profile.cli('provider', 'readiness', 'codex', '--account', account.id)
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ type: 'provider_readiness', state: 'account_disabled', account_id: account.id })
})

test('F027: Claude readiness reports missing, incompatible, stuck, unauthenticated, unverified, ready and changed identity', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  expect(await readiness(profile, 'claude')).toMatchObject({ state: 'installed_unchecked' })

  const { account } = await profile.call('account.create', { provider: 'claude', name: 'Personal' })
  await readinessBecomes(profile, 'claude', account.id, {
    state: 'needs_authentication',
    version: compatibleVersions.claude,
  })
  await clis.invalidateCredentials('claude', account.native_home)
  await readinessBecomes(profile, 'claude', account.id, {
    state: 'needs_authentication',
    version: compatibleVersions.claude,
  })

  await clis.signIn('claude', account.native_home, { email: 'me@example.invalid', account_id: 'org-me' })
  await readinessBecomes(profile, 'claude', account.id, { state: 'needs_verification' })
  await verify(profile, account.id)
  await readinessBecomes(profile, 'claude', account.id, { state: 'ready', version: compatibleVersions.claude })

  await clis.install('claude', '2.0.9')
  const incompatible = await readinessBecomes(profile, 'claude', account.id, {
    state: 'incompatible',
    version: '2.0.9',
  })
  expect(incompatible.reason).toMatch(/validated 2\.1\.x range/)

  // A CLI that never answers is a failed check, not an incompatible one.
  await clis.install('claude', compatibleVersions.claude, { hangs: true })
  const stuck = await readiness(profile, 'claude', account.id)
  expect(stuck).toMatchObject({ state: 'unavailable', version: null })
  expect(stuck.reason).toMatch(/timed out; retry/)

  await clis.uninstall('claude')
  const missing = await readiness(profile, 'claude', account.id)
  expect(missing.state).toBe('missing_executable')
  expect(missing.reason).toMatch(/ADE_CLAUDE_BIN/)
  // Without an account the missing executable is still reported.
  expect(await readiness(profile, 'claude')).toMatchObject({ state: 'missing_executable' })

  await clis.install('claude', compatibleVersions.claude)
  await readinessBecomes(profile, 'claude', account.id, { state: 'ready' })
  await clis.signIn('claude', account.native_home, { email: 'someone-else@example.invalid', account_id: 'org-me' })
  await readinessBecomes(profile, 'claude', account.id, { state: 'identity_changed' })
})

test('F027: providers without a managed-account probe say what is unchecked, and bad readiness queries are refused', async ({
  ade,
}) => {
  const { profile, clis } = await profileWithClis(ade)
  const account = await verifiedAccount(profile, clis, 'codex', 'Work', {
    email: 'w@example.invalid',
    account_id: 'org-w',
  })

  // Oh My Pi ships with ADE; only an override would be checked.
  const omp = await readiness(profile, 'omp')
  expect(omp.state).toBe('installed_unchecked')
  expect(omp.checks).toContainEqual(expect.objectContaining({ check: 'executable:omp', state: 'skipped' }))

  await expect(readiness(profile, 'no-such-provider')).rejects.toThrow(/Unknown provider/)
  await expect(readiness(profile, 'claude', account.id)).rejects.toThrow(/another provider/)
  await expect(readiness(profile, 'codex', 'account_missing')).rejects.toThrow()
  const cli = await profile.cli('provider', 'readiness')
  expect(cli.code).not.toBe(0)

  // A daemon restart keeps the pinned identity; readiness is computed again.
  await profile.restartDaemon('kill')
  await readinessBecomes(profile, 'codex', account.id, { state: 'ready' })
})

test('F027: Bun is required only by the shared Codex transport, never by a managed-account launch', async ({ ade }) => {
  const clis = await FakeProviderClis.create(ade)
  const profile = await ade.profile({
    env: { ...clis.env, ADE_CODEX_TRANSPORT: 'shared', ADE_BUN_BIN: join(ade.root, 'no-bun-here') },
  })
  // A launch on Codex's own login would run the shared transport, which needs Bun.
  const ambient = await readiness(profile, 'codex')
  expect(ambient.state).toBe('missing_executable')
  expect(ambient.reason).toMatch(/ADE_BUN_BIN/)
  // A managed account runs the Codex CLI directly, so the same host is ready for it.
  const account = await verifiedAccount(profile, clis, 'codex', 'Work', {
    email: 'w@example.invalid',
    account_id: 'org-w',
  })
  const managed = await readinessBecomes(profile, 'codex', account.id, { state: 'ready' })
  expect(managed.checks).toContainEqual({
    check: 'runtime:bun',
    state: 'skipped',
    detail: expect.stringMatching(/Not used/),
  })
})
