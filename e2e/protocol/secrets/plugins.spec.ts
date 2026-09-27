// F059 plugin credentials (architecture section 7): a `credential_ref`
// setting stores a typed reference, never a secret. `{"secret": "..."}` moves
// a value into an item the profile owns in its secret store: the Keychain in
// production, the test-only encrypted file store here (fixtures/secret-store.ts).
// The plugin sees the reference in its settings and, at each host activation,
// the value the daemon resolved; no reply or database row carries the value.
// A reference that names nothing refuses the host start before any plugin
// code runs.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { installAndEnable, pluginLines, stagePlugin } from '../fixtures/plugins'
import {
  ADE_KEYCHAIN_SERVICE,
  REDACTED,
  filesHolding,
  ownedReference,
  pluginsDatabase,
  sha256,
  storeHoldsPlainly,
  type KeychainReference,
} from './helpers'

const SECRET = 'plugin-secret-91b2f0'

/** A second plugin with the same settings and no commands; its host never starts. */
const otherManifest = {
  id: 'e2e.other',
  contributes: {
    settings: [
      { key: 'out_dir', title: 'Output', kind: 'string', default: '' },
      { key: 'token', title: 'Token', kind: 'credential_ref' },
    ],
  },
}

async function token(profile: ScratchProfile, pluginId: string): Promise<unknown> {
  const { settings } = await profile.call('plugin.setting.list', { plugin_id: pluginId })
  return settings.find((setting) => setting.key === 'token')?.value
}

/** Restart the plugin's host and return what its new activation saw. */
async function activation(profile: ScratchProfile, pluginId: string, outDir: string) {
  await profile.call('plugin.host.restart', { plugin_id: pluginId })
  const lines = await pluginLines(outDir, 'lifecycle.jsonl')
  return lines.filter((line) => line.event === 'activate').at(-1)!
}

test('a plugin credential is stored as a reference and its value reaches only the activated plugin', async ({
  ade,
  profile,
}) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))

  // A secret sent once moves into an item ADE owns; the setting holds its reference.
  const set = await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'token', value: { secret: SECRET } })
  expect(JSON.stringify(set)).not.toContain(SECRET)
  const reference = (await token(profile, pluginId)) as KeychainReference
  expect(reference).toEqual(await ownedReference(profile, `plugin/${pluginId}/token`))
  // The item holds the value, encrypted at rest; no profile file holds it.
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([reference.keychain.account])
  expect(await profile.secrets.find(ADE_KEYCHAIN_SERVICE, reference.keychain.account)).toBe(SECRET)
  expect(await filesHolding(profile, SECRET)).toEqual([])
  expect(await storeHoldsPlainly(profile, SECRET)).toBe(false)

  // Sending the same secret again converges on the same item.
  await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'token', value: { secret: SECRET } })
  expect(await token(profile, pluginId)).toEqual(reference)
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([reference.keychain.account])

  // The activated plugin gets the reference in settings and the value as a credential.
  expect(await activation(profile, pluginId, outDir)).toMatchObject({
    token_reference: reference,
    token_sha256: sha256(SECRET),
  })
  const invoked = await profile.call('plugin.command.invoke', {
    operation_id: 'echo-1',
    plugin_id: pluginId,
    command_id: 'e2e.backend.echo',
    args: null,
  })
  expect(JSON.stringify(invoked)).not.toContain(SECRET)

  // Refused: a bare string, an empty secret, and another plugin's item.
  for (const value of ['raw-token-in-a-string', { secret: '' }, { secret: 'x', extra: 1 }]) {
    await expect(
      profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'token', value }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  }
  const other = await installAndEnable(profile, await stagePlugin(ade.root, 'backend', otherManifest))
  await expect(
    profile.call('plugin.setting.set', { plugin_id: other.pluginId, key: 'token', value: reference }),
  ).rejects.toMatchObject({
    code: 'invalid_request',
    message: expect.stringMatching(/Keychain item ADE made for another secret/),
  })
  expect(await token(profile, pluginId)).toEqual(reference)

  // Rotation makes a new item and deletes the old one.
  await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'token', value: { secret: 'rotated-91b2f0' } })
  const rotated = (await token(profile, pluginId)) as KeychainReference
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([rotated.keychain.account])
  expect(await activation(profile, pluginId, outDir)).toMatchObject({ token_sha256: sha256('rotated-91b2f0') })

  // A reference to the daemon's environment replaces ADE's item, which is deleted.
  await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'token', value: { env: 'E2E_PLUGIN_TOKEN' } })
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([])
  const activations = (await pluginLines(outDir, 'lifecycle.jsonl')).filter((line) => line.event === 'activate').length
  // The daemon has no such variable: the host start is refused before plugin code runs.
  await expect(profile.call('plugin.host.restart', { plugin_id: pluginId })).rejects.toMatchObject({
    code: 'failed',
    message: expect.stringMatching(
      /Credential setting token cannot be resolved: environment variable E2E_PLUGIN_TOKEN is not set/,
    ),
  })
  expect((await pluginLines(outDir, 'lifecycle.jsonl')).filter((line) => line.event === 'activate')).toHaveLength(
    activations,
  )

  // Given the variable, a killed daemon comes back and activates with it.
  profile.env.E2E_PLUGIN_TOKEN = 'from-daemon-env'
  await profile.restartDaemon('kill')
  expect(await token(profile, pluginId)).toEqual({ env: 'E2E_PLUGIN_TOKEN' })
  expect(await activation(profile, pluginId, outDir)).toMatchObject({
    token_reference: { env: 'E2E_PLUGIN_TOKEN' },
    token_sha256: sha256('from-daemon-env'),
  })

  // Uninstalling with purge deletes the item ADE made; without purge it stays.
  await profile.call('plugin.setting.set', { plugin_id: pluginId, key: 'token', value: { secret: SECRET } })
  await profile.call('plugin.disable', { plugin_id: pluginId })
  await profile.call('plugin.uninstall', { operation_id: 'keep', plugin_id: pluginId })
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toHaveLength(1)
  await profile.call('plugin.install', {
    operation_id: 'again',
    source: { kind: 'local', path: await stagePlugin(ade.root, 'backend') },
  })
  await profile.call('plugin.uninstall', { operation_id: 'purge', plugin_id: pluginId, purge_data: true })
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([])
})

test('a plugin credential stored as text before references moves into the secret store when the profile opens', async ({
  ade,
  profile,
}) => {
  const { pluginId, outDir } = await installAndEnable(profile, await stagePlugin(ade.root, 'backend'))
  const other = await installAndEnable(profile, await stagePlugin(ade.root, 'backend', otherManifest))

  // Rewrite the settings as an older ADE stored them: free text.
  await profile.stop()
  const db = new DatabaseSync(pluginsDatabase(profile))
  const insert = db.prepare(`INSERT INTO plugin_settings(plugin_id,key,value,updated_at) VALUES(?,?,?,0)
    ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value`)
  insert.run(pluginId, 'token', JSON.stringify(SECRET))
  insert.run(other.pluginId, 'token', JSON.stringify('env:E2E_OTHER_TOKEN'))
  db.close()
  expect(await filesHolding(profile, SECRET)).not.toEqual([])

  // Without a usable store the secret cannot move: it is never shown or
  // given to the plugin. A text that names a reference needs no store.
  const store = profile.env.ADE_SECRET_FILE
  profile.env.ADE_SECRET_FILE = join(profile.home, 'missing', 'store.json')
  await profile.restartDaemon()
  expect(await token(profile, pluginId)).toBe(REDACTED)
  expect(await token(profile, other.pluginId)).toEqual({ env: 'E2E_OTHER_TOKEN' })
  await expect(profile.call('plugin.host.restart', { plugin_id: pluginId })).rejects.toMatchObject({
    code: 'failed',
    message: expect.stringMatching(/Credential setting token is still stored in plain text/),
  })

  // The next open with the store moves it; no plugin file keeps a copy.
  profile.env.ADE_SECRET_FILE = store
  await profile.restartDaemon()
  const reference = (await token(profile, pluginId)) as KeychainReference
  expect(reference).toEqual(await ownedReference(profile, `plugin/${pluginId}/token`))
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([reference.keychain.account])
  expect(await filesHolding(profile, SECRET)).toEqual([])
  expect(await activation(profile, pluginId, outDir)).toMatchObject({
    token_reference: reference,
    token_sha256: sha256(SECRET),
  })
})
