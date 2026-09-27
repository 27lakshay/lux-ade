// F089 and D15: a backup bundle never carries a secret service value. The
// bundle's profile database stores each secret as `[redacted]`, the manifest
// declares the exclusion, and the restored service refuses to start until its
// secret is sent again. A bundle that holds a secret fails verification.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { control } from '../fixtures/control'
import { writeEnvEchoPrograms } from '../fixtures/env-echo'
import { httpGet, waitForReadiness } from '../fixtures/services'
import { copyBundle, createBackup, readManifest, restoreIntoNewProfile, rewriteDatabase } from './helpers'

const SECRET = 'bundle-secret-7f3a9c'
const REDACTED = '[redacted]'

/** Every file below `directory`, recursively. */
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

test('a backup withholds secret service values and the restored service needs them sent again', async ({ ade, profile }) => {
  test.setTimeout(120_000)
  // The programs live outside the workspace, so the restored service runs
  // them from its rebound folder.
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const programs = await writeEnvEchoPrograms(join(ade.root, 'programs'))
  const config = { program: process.execPath, args: [programs.server], ports: ['PORT'],
    env: { API_TOKEN: SECRET, MODE: 'development', E2E_ECHO: 'API_TOKEN,MODE' }, secret_env: ['API_TOKEN'] }
  const configured = (await profile.call('service.configure', { workspace_id: workspace.id, name: 'api',
    revision: 0, config })).service

  // The source profile stores the secret and launches with it.
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json)
    .toMatchObject({ env: { API_TOKEN: SECRET } })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })

  const { path: bundle, result } = await createBackup(ade, profile)
  expect(result.code, result.stderr).toBe(0)

  // No byte of the bundle carries the secret; the manifest says why.
  const bundled = await files(bundle)
  expect(bundled).toContain(join(bundle, 'sessions.sqlite'))
  for (const file of bundled) {
    expect((await readFile(file)).includes(SECRET), file).toBe(false)
  }
  const manifest = await readManifest(bundle)
  expect(manifest.format_version).toBe(5)
  expect(manifest.excluded.join('\n')).toMatch(/secret service environment values/)
  expect(manifest.coverage).toEqual(expect.arrayContaining([
    expect.objectContaining({ store: 'sessions.sqlite#service_secrets', disposition: 'excluded' })]))
  const inspected = await control(ade, ['backup', 'inspect', '--backup', bundle])
  expect(inspected.code, inspected.stderr).toBe(0)

  // The source profile is untouched: it still launches with the real value.
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json)
    .toMatchObject({ env: { API_TOKEN: SECRET } })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })

  // A bundle whose database holds a secret value fails verification.
  const leaky = await copyBundle(bundle, join(ade.root, 'leaky'))
  await rewriteDatabase(leaky, (db) => db.exec(
    `UPDATE services SET data=json_set(data,'$.config.env.API_TOKEN','${SECRET}')`))
  const refused = await control(ade, ['backup', 'inspect', '--backup', leaky])
  expect(refused.code).not.toBe(0)
  expect(String(refused.json?.message)).toContain('Backup holds a secret service value it declares excluded')

  // The restored profile keeps the configuration but not the secret.
  const restored = await restoreIntoNewProfile(ade, bundle)
  const fenced = (await restored.call('workspace.rebind.list', {})).workspaces
    .find((candidate) => candidate.id === workspace.id)!
  expect(fenced).toMatchObject({ needs_rebind: true })
  const rebound = (await restored.call('workspace.rebind', { workspace_id: fenced.id,
    path: restored.defaultWorkspaceRoot })).workspace
  const kept = (await restored.call('service.inspect', { workspace_id: rebound.id, name: 'api' })).service
  expect(kept.config).toMatchObject({ secret_env: ['API_TOKEN'],
    env: { API_TOKEN: REDACTED, MODE: 'development' } })

  // Starting is a definite refusal that names the secret; nothing runs.
  await expect(restored.call('service.start', { workspace_id: rebound.id, name: 'api' }))
    .rejects.toThrow(/Secret API_TOKEN was withheld from a backup; configure its value before starting the service/)
  const listed = await restored.call('service.list', { workspace_id: rebound.id })
  expect(listed.services[0].terminal_owner ?? null).toBeNull()
  // Saving the redacted view cannot turn the placeholder into a value.
  await expect(restored.call('service.configure', { workspace_id: rebound.id, name: 'api',
    revision: kept.revision, config: kept.config }))
    .rejects.toThrow(/Secret API_TOKEN was withheld from a backup; send its value/)

  // Sending the value again makes the service launch with it.
  await restored.call('service.configure', { workspace_id: rebound.id, name: 'api', revision: kept.revision,
    config: { ...kept.config, env: { ...kept.config.env, API_TOKEN: 'resent-value' } } })
  await restored.call('service.start', { workspace_id: rebound.id, name: 'api' })
  await waitForReadiness(restored, rebound.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${kept.ports.PORT}/`)).json)
    .toMatchObject({ env: { API_TOKEN: 'resent-value', MODE: 'development' } })
  await restored.call('service.stop', { workspace_id: rebound.id, name: 'api' })
})
