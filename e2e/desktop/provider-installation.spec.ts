import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { installAndEnable, providerSdkDiagnosticArtifact } from '../protocol/fixtures/plugins'

test('Settings reconcile installed provider inspection and keep readiness read-only', async ({
  ade,
  profile,
  desktop,
}, testInfo) => {
  const artifact = await providerSdkDiagnosticArtifact(ade.root)
  const metadata = JSON.parse(await readFile(join(artifact, 'ade-plugin.json'), 'utf8')) as {
    id: string
    version: string
  }
  const { pluginId } = await installAndEnable(profile, artifact, 'provider-inspection-diagnostic')
  expect(pluginId).toBe(metadata.id)

  const provider = 'plugin:' + metadata.id
  const nativeCallsBefore = {
    codex: await profile.mockCalls('codex'),
    claude: await profile.mockCalls('claude'),
  }
  expect(nativeCallsBefore).toEqual({ codex: [], claude: [] })
  const sdkInspection = await profile.call('provider.inspect', { provider })
  const cliInspection = await profile.cli('provider', 'inspect', provider)
  expect(cliInspection.code, cliInspection.stderr).toBe(0)
  expect(cliInspection.json).toMatchObject(sdkInspection)
  expect(sdkInspection.provider).toBe(provider)
  expect(sdkInspection.version).toBe(metadata.version)
  const version = sdkInspection.version
  const descriptor = sdkInspection.descriptor
  if (!version || !descriptor) throw new Error('The installed provider inspection omitted its identity or descriptor')

  const initializeOperation = descriptor.operations.find((operation) => operation.method === 'initialize')
  const sendOperation = descriptor.operations.find((operation) => operation.method === 'send')
  if (!initializeOperation || !sendOperation) throw new Error('The worker inspection omitted a public operation')
  expect(initializeOperation.availability).toBe('available')
  expect(sendOperation.availability).toBe('unsupported')

  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(window.getByRole('heading', { name: 'Provider SDK inspection' })).toBeVisible()

  const providerInput = window.getByRole('textbox', { name: 'Plugin provider ID' })
  await providerInput.fill(provider)
  await window.getByRole('button', { name: 'Inspect provider', exact: true }).click()
  await expect(window.getByRole('heading', { name: descriptor.name, exact: true })).toBeVisible()
  const inspectionStatus = 'Inspection complete: ' + sdkInspection.state + '.'
  await expect(window.getByRole('status').filter({ hasText: inspectionStatus })).toBeVisible()
  const providerVersion = window.getByRole('region', { name: 'Provider version' })
  await expect(providerVersion.getByText(version, { exact: true })).toBeVisible()

  const operations = window.getByRole('region', { name: 'Operations' })
  await expect(operations.getByRole('listitem').filter({ hasText: initializeOperation.method })).toContainText(
    initializeOperation.availability,
  )
  await expect(operations.getByRole('listitem').filter({ hasText: sendOperation.method })).toContainText(
    sendOperation.availability,
  )
  await testInfo.attach('provider-inspection.json', {
    body: JSON.stringify({ artifact: metadata, sdk: sdkInspection, cli: cliInspection.json }, null, 2),
    contentType: 'application/json',
  })

  await window.getByRole('button', { name: 'Check readiness', exact: true }).click()
  const readiness = await profile.call('provider.readiness', { provider })
  const initializeCheck = readiness.checks.find((check) => check.check === 'worker.initialize')
  const nativeWorkCheck = readiness.checks.find((check) => check.check === 'provider.native_work')
  if (!initializeCheck || !nativeWorkCheck) throw new Error('Readiness omitted a required public check')
  expect(initializeCheck.state).toBe('passed')
  expect(nativeWorkCheck.state).toBe('skipped')

  const readinessRegion = window.getByRole('region', { name: 'Read-only readiness' })
  const initializeRow = readinessRegion.getByRole('listitem').filter({ hasText: initializeCheck.check })
  const nativeWorkRow = readinessRegion.getByRole('listitem').filter({ hasText: nativeWorkCheck.check })
  await expect(initializeRow).toContainText(initializeCheck.state)
  await expect(nativeWorkRow).toContainText(nativeWorkCheck.state)
  await expect(nativeWorkRow).toContainText(nativeWorkCheck.detail)
  await expect(readinessRegion.getByRole('listitem').filter({ hasText: /account/i })).toHaveCount(0)

  // The shared fixture logs actual provider CLI invocations; unchanged logs prove readiness did not start one.
  const nativeCallsAfter = {
    codex: await profile.mockCalls('codex'),
    claude: await profile.mockCalls('claude'),
  }
  expect(nativeCallsAfter).toEqual(nativeCallsBefore)
  await testInfo.attach('native-provider-call-audit.json', {
    body: JSON.stringify({ before: nativeCallsBefore, after: nativeCallsAfter }, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('provider-readiness.png', {
    body: await window.screenshot(),
    contentType: 'image/png',
  })

  const missingProvider = 'plugin:e2e.missing-provider'
  const missingInspection = await profile.call('provider.inspect', { provider: missingProvider })
  const missingCli = await profile.cli('provider', 'inspect', missingProvider)
  expect(missingCli.code, missingCli.stderr).toBe(0)
  expect(missingCli.json).toMatchObject(missingInspection)
  expect(missingInspection.state).toBe('missing_executable')
  expect(missingInspection.reason.trim()).not.toBe('')

  await providerInput.fill(missingProvider)
  await window.getByRole('button', { name: 'Inspect provider', exact: true }).click()
  await expect(window.getByRole('alert')).toContainText(missingInspection.state)
  await expect(window.getByText(missingInspection.reason, { exact: true })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Check readiness', exact: true })).toBeDisabled()
})
