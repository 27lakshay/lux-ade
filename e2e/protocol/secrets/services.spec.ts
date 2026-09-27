// F089 at rest (architecture section 7): a service secret is stored as a
// credential reference, never as its value. A value sent to `service.configure`
// moves into a Keychain item ADE owns; a reference the user gives names an
// environment variable of the daemon or their own Keychain item. The daemon
// resolves references only when the service launches, and a reference that
// names nothing refuses the start before anything is reserved. Every profile
// keeps its items in the test-only encrypted file store in its scratch HOME
// (fixtures/secret-store.ts), which stands in for the Keychain; no spec
// reaches the real Keychain. The item store is the only place a value lives,
// and it holds no value in plain text.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { writeEnvEchoPrograms } from '../fixtures/env-echo'
import { httpGet, waitForReadiness } from '../fixtures/services'
import {
  ADE_KEYCHAIN_SERVICE,
  REDACTED,
  filesHolding,
  ownedReference,
  sessionsDatabase,
  storeHoldsPlainly,
  type KeychainReference,
} from './helpers'

const SECRET = 'svc-secret-4d1c7e'

test('a secret sent as a value moves into the secret store and ADE keeps only its reference', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeEnvEchoPrograms(repo.path)
  const config = {
    program: process.execPath,
    args: [files.server],
    ports: ['PORT'],
    env: { API_TOKEN: SECRET, MODE: 'development', E2E_ECHO: 'API_TOKEN,MODE' },
    secret_env: ['API_TOKEN'],
  }
  const configured = (
    await profile.call('service.configure', { workspace_id: workspace.id, name: 'api', revision: 0, config })
  ).service
  expect(configured.config.env).toEqual({ API_TOKEN: REDACTED, MODE: 'development', E2E_ECHO: 'API_TOKEN,MODE' })
  expect(configured.config.secret_refs).toEqual({
    API_TOKEN: await ownedReference(profile, `service/${workspace.id}/api/API_TOKEN`),
  })
  const reference = configured.config.secret_refs!.API_TOKEN as KeychainReference

  // The value lives in the store's item, and in no file of the profile; the
  // store itself is encrypted at rest. The launch below proves what it holds.
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([reference.keychain.account])
  expect(await profile.secrets.find(ADE_KEYCHAIN_SERVICE, reference.keychain.account)).toBe(SECRET)
  expect(await filesHolding(profile, SECRET)).toEqual([])
  expect(await storeHoldsPlainly(profile, SECRET)).toBe(false)

  // It resolves at launch and reaches the process.
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json).toMatchObject({
    env: { API_TOKEN: SECRET, MODE: 'development' },
  })
  const views = [
    await profile.call('service.list', { workspace_id: workspace.id }),
    await profile.call('service.inspect', { workspace_id: workspace.id, name: 'api' }),
    (await profile.cli('service', 'inspect', workspace.id, 'api')).json,
  ]
  for (const view of views) expect(JSON.stringify(view)).not.toContain(SECRET)

  // Editing a running service is refused before any item is made.
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'api',
      revision: 1,
      config: { ...config, env: { ...config.env, API_TOKEN: 'while-running' } },
    }),
  ).rejects.toThrow(/Stop the service before editing it/)
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([reference.keychain.account])
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })

  // A duplicate of the first request, value and stale revision included,
  // converges on the item that already holds the value.
  const duplicate = (
    await profile.call('service.configure', { workspace_id: workspace.id, name: 'api', revision: 0, config })
  ).service
  expect(duplicate.revision).toBe(1)
  expect(duplicate.config.secret_refs).toEqual(configured.config.secret_refs)
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([reference.keychain.account])

  // A conflicting save with a new value is refused and leaves no orphan item.
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'api',
      revision: 0,
      config: { ...config, env: { ...config.env, API_TOKEN: 'conflicting-value' } },
    }),
  ).rejects.toThrow(/Service changed; reload before saving/)
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([reference.keychain.account])
  expect((await profile.call('service.inspect', { workspace_id: workspace.id, name: 'api' })).service).toMatchObject({
    revision: 1,
    config: { secret_refs: { API_TOKEN: reference } },
  })

  // ADE's item is kept only by the secret it was made for.
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'copy',
      revision: 0,
      config: { program: process.execPath, args: [files.print], secret_refs: { STOLEN: reference } },
    }),
  ).rejects.toThrow(/Keychain item ADE made for another secret/)

  // Rotation makes a new item, deletes the old one, and the process gets the new value.
  const rotated = (
    await profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'api',
      revision: 1,
      config: { ...config, env: { ...config.env, API_TOKEN: 'rotated-4d1c7e' } },
    })
  ).service
  const next = rotated.config.secret_refs!.API_TOKEN as KeychainReference
  expect(next.keychain.account).not.toBe(reference.keychain.account)
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([next.keychain.account])

  // A killed daemon comes back resolving the same reference.
  await profile.restartDaemon('kill')
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json).toMatchObject({
    env: { API_TOKEN: 'rotated-4d1c7e' },
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })

  // Removing the service deletes the item ADE made for it.
  await profile.call('service.remove', { workspace_id: workspace.id, name: 'api', revision: rotated.revision })
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([])
})

test('references resolve only at launch, and one that names nothing refuses the start before anything is reserved', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeEnvEchoPrograms(repo.path)
  await profile.secrets.add('e2e-user', 'api', 'from-user-keychain')
  const userItem = { keychain: { service: 'e2e-user', account: 'api' } }
  const config = {
    program: process.execPath,
    args: [files.server],
    ports: ['PORT'],
    env: { E2E_ECHO: 'API_TOKEN,SESSION' },
    secret_refs: { API_TOKEN: userItem, SESSION: { env: 'E2E_SESSION_TOKEN' } },
  }
  const configured = (
    await profile.call('service.configure', { workspace_id: workspace.id, name: 'api', revision: 0, config })
  ).service
  expect(configured.config).toMatchObject({
    secret_env: ['API_TOKEN', 'SESSION'],
    env: { API_TOKEN: REDACTED, SESSION: REDACTED },
    secret_refs: config.secret_refs,
  })
  // A reference is not a value, so ADE added no item.
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([])

  const unreserved = async () => {
    const listed = await profile.call('service.list', { workspace_id: workspace.id })
    const service = listed.services.find((candidate) => candidate.name === 'api')!
    return {
      owner: service.terminal_owner ?? null,
      terminal: service.terminal_id ?? null,
      run: service.last_run_transfer_id ?? null,
    }
  }
  // The daemon has no E2E_SESSION_TOKEN: the start is refused and nothing is reserved.
  await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'api' })).rejects.toThrow(
    /Secret SESSION cannot be resolved: environment variable E2E_SESSION_TOKEN is not set/,
  )
  expect(await unreserved()).toEqual({ owner: null, terminal: null, run: null })

  // Given the variable, the daemon launches with both values.
  profile.env.E2E_SESSION_TOKEN = 'from-daemon-env'
  await profile.restartDaemon()
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json).toMatchObject({
    env: { API_TOKEN: 'from-user-keychain', SESSION: 'from-daemon-env' },
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })

  // Nothing is cached: the next launch reads the item as it is now.
  await profile.secrets.add('e2e-user', 'api', 'changed-by-user')
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json).toMatchObject({
    env: { API_TOKEN: 'changed-by-user' },
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })
  const ran = await unreserved()

  // A deleted item refuses the start before anything is reserved again.
  await profile.secrets.delete('e2e-user', 'api')
  await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'api' })).rejects.toThrow(
    /Secret API_TOKEN cannot be resolved: Keychain item "e2e-user" account "api" cannot be read: the item does not exist/,
  )
  expect(await unreserved()).toEqual({ ...ran, owner: null })

  // Refused shapes: a pasted token as a variable name, and a value sent with a reference.
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'bad',
      revision: 0,
      config: { program: process.execPath, args: [files.print], secret_refs: { T: { env: 'ghp_pasted_token' } } },
    }),
  ).rejects.toThrow(/uppercase name/)
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'bad',
      revision: 0,
      config: {
        program: process.execPath,
        args: [files.print],
        env: { T: 'value' },
        secret_refs: { T: { env: 'HOST_T' } },
      },
    }),
  ).rejects.toThrow(/both a value and a reference/)

  // ADE never deletes an item the user made: removing the service leaves it.
  await profile.secrets.add('e2e-user', 'api', 'kept')
  await profile.call('service.remove', { workspace_id: workspace.id, name: 'api', revision: configured.revision })
  expect(await profile.secrets.find('e2e-user', 'api')).toBe('kept')
})

test('a secret stored in plain text before references moves into the secret store when the profile opens', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeEnvEchoPrograms(repo.path)
  const configured = (
    await profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'api',
      revision: 0,
      config: {
        program: process.execPath,
        args: [files.server],
        ports: ['PORT'],
        env: { API_TOKEN: 'placeholder', E2E_ECHO: 'API_TOKEN' },
        secret_env: ['API_TOKEN'],
      },
    })
  ).service
  const placeholder = configured.config.secret_refs!.API_TOKEN as KeychainReference

  // Rewrite the record as an older ADE stored it: the value in plain text.
  await profile.stop()
  await profile.secrets.delete(ADE_KEYCHAIN_SERVICE, placeholder.keychain.account)
  const db = new DatabaseSync(sessionsDatabase(profile))
  db.prepare(`UPDATE services SET data=json_set(json_remove(data,'$.config.secret_refs'),'$.config.env.API_TOKEN',?)
    WHERE name='api'`).run(SECRET)
  db.close()
  expect(await filesHolding(profile, SECRET)).not.toEqual([])

  // Opened without a usable store, the value cannot move. It is never
  // shown and never launched, and the profile still opens.
  const store = profile.env.ADE_SECRET_FILE
  profile.env.ADE_SECRET_FILE = join(profile.home, 'missing', 'store.json')
  await profile.restartDaemon()
  const stuck = (await profile.call('service.inspect', { workspace_id: workspace.id, name: 'api' })).service
  expect(stuck.config.env.API_TOKEN).toBe(REDACTED)
  expect(stuck.config.secret_refs).toBeUndefined()
  expect(JSON.stringify(await profile.call('service.list', { workspace_id: workspace.id }))).not.toContain(SECRET)
  await expect(profile.call('service.start', { workspace_id: workspace.id, name: 'api' })).rejects.toThrow(
    /Secret API_TOKEN is still stored in plain text/,
  )
  expect(
    (await profile.call('service.inspect', { workspace_id: workspace.id, name: 'api' })).service.terminal_owner ?? null,
  ).toBeNull()

  // The next open with the store moves it, and the database keeps no copy.
  profile.env.ADE_SECRET_FILE = store
  await profile.restartDaemon()
  const moved = (await profile.call('service.inspect', { workspace_id: workspace.id, name: 'api' })).service
  expect(moved.config.secret_refs).toEqual({
    API_TOKEN: await ownedReference(profile, `service/${workspace.id}/api/API_TOKEN`),
  })
  const reference = moved.config.secret_refs!.API_TOKEN as KeychainReference
  expect(await profile.secrets.accounts(ADE_KEYCHAIN_SERVICE)).toEqual([reference.keychain.account])
  expect(await filesHolding(profile, SECRET)).toEqual([])
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json).toMatchObject({
    env: { API_TOKEN: SECRET },
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })
})
