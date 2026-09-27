// F089 effective nonsecret configuration: a service recipe marks environment
// values secret with `secret_env`. Every reply, feed frame and CLI view shows
// them as `[redacted]`, while the running process receives the real value.
// Saving a configuration that was read back keeps the stored secret; the
// placeholder is never stored as a value.
import { expect, test } from '../fixtures'
import { subscribeFeed } from '../fixtures/feed'
import { printedEnv, writeEnvEchoPrograms } from '../fixtures/env-echo'
import { httpGet, logText, waitForReadiness } from '../fixtures/services'

const SECRET = 's3cret-token-value'
const REDACTED = '[redacted]'

test('secret service values are redacted everywhere ADE shows them and reach only the process', async ({
  profile,
  repo,
}) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeEnvEchoPrograms(repo.path)
  const feed = await subscribeFeed(profile)
  await feed.connected()
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
  // The effective configuration is visible; only the secret value is hidden.
  expect(configured.config.env).toEqual({ API_TOKEN: REDACTED, MODE: 'development', E2E_ECHO: 'API_TOKEN,MODE' })
  expect(configured.config.secret_env).toEqual(['API_TOKEN'])

  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  expect(started.service.config.env.API_TOKEN).toBe(REDACTED)
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')

  // The process received the real value.
  const seen = await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)
  expect(seen.json).toMatchObject({ env: { API_TOKEN: SECRET, MODE: 'development' } })

  // No view ADE offers carries the secret.
  const views: unknown[] = [
    configured,
    started,
    await profile.call('service.list', { workspace_id: workspace.id }),
    await profile.call('service.inspect', { workspace_id: workspace.id, name: 'api' }),
    (await profile.cli('service', 'list', workspace.id)).json,
    (await profile.cli('service', 'inspect', workspace.id, 'api')).json,
  ]
  const changed = await feed.waitFor(
    (frame) =>
      frame.type === 'service_changed' &&
      (frame.service as { name?: string }).name === 'api' &&
      frame.metrics !== undefined,
  )
  views.push(changed)
  feed.stop()
  for (const view of views) {
    expect(view).toBeTruthy()
    expect(JSON.stringify(view)).not.toContain(SECRET)
  }
  expect((changed.service as { config: { env: Record<string, string> } }).config.env.API_TOKEN).toBe(REDACTED)
  const listed = await profile.call('service.list', { workspace_id: workspace.id })
  expect(listed.services[0].config.env.API_TOKEN).toBe(REDACTED)
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })

  // Saving the configuration as it was read keeps the stored secret: the same
  // configuration converges without a new revision.
  const same = (
    await profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'api',
      revision: 1,
      config: listed.services[0].config,
    })
  ).service
  expect(same.revision).toBe(1)
  // Editing another field through the redacted view keeps the secret too.
  const edited = (
    await profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'api',
      revision: 1,
      config: { ...listed.services[0].config, env: { ...listed.services[0].config.env, MODE: 'production' } },
    })
  ).service
  expect(edited).toMatchObject({ revision: 2, config: { env: { API_TOKEN: REDACTED, MODE: 'production' } } })

  // The restarted daemon still redacts and still launches with the real value.
  await profile.restartDaemon('kill')
  expect(
    (await profile.call('service.inspect', { workspace_id: workspace.id, name: 'api' })).service.config.env.API_TOKEN,
  ).toBe(REDACTED)
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json).toMatchObject({
    env: { API_TOKEN: SECRET, MODE: 'production' },
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })

  // A new value replaces the secret.
  await profile.call('service.configure', {
    workspace_id: workspace.id,
    name: 'api',
    revision: 2,
    config: { ...config, env: { ...config.env, API_TOKEN: 'rotated-value' } },
  })
  await profile.call('service.start', { workspace_id: workspace.id, name: 'api' })
  await waitForReadiness(profile, workspace.id, 'api', 'tcp_listening')
  expect((await httpGet(`http://127.0.0.1:${configured.ports.PORT}/`)).json).toMatchObject({
    env: { API_TOKEN: 'rotated-value' },
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'api' })
})

test('the redaction placeholder is never stored as a secret value', async ({ profile, repo }) => {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeEnvEchoPrograms(repo.path)
  const base = { program: process.execPath, args: [files.print] }

  // A new secret must carry its value.
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'job',
      revision: 0,
      config: { ...base, env: { TOKEN: REDACTED }, secret_env: ['TOKEN'] },
    }),
  ).rejects.toThrow(/Secret TOKEN has no stored value; send its value/)
  // A secret name must be a configured variable.
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'job',
      revision: 0,
      config: { ...base, env: {}, secret_env: ['TOKEN'] },
    }),
  ).rejects.toThrow(/Secret service environment names must be configured environment variables/)
  expect((await profile.call('service.list', { workspace_id: workspace.id })).services).toEqual([])

  // A value that was not secret is not kept by the placeholder when it becomes secret.
  await profile.call('service.configure', {
    workspace_id: workspace.id,
    name: 'job',
    revision: 0,
    config: { ...base, env: { TOKEN: 'plain' } },
  })
  await expect(
    profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'job',
      revision: 1,
      config: { ...base, env: { TOKEN: REDACTED }, secret_env: ['TOKEN'] },
    }),
  ).rejects.toThrow(/Secret TOKEN has no stored value/)
  // Marking it secret with its value works; unmarking it shows it again.
  const marked = (
    await profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'job',
      revision: 1,
      config: { ...base, env: { TOKEN: 'plain' }, secret_env: ['TOKEN'] },
    })
  ).service
  expect(marked.config.env.TOKEN).toBe(REDACTED)
  const unmarked = (
    await profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'job',
      revision: 2,
      config: { ...base, env: { TOKEN: 'plain' } },
    })
  ).service
  expect(unmarked.config.env.TOKEN).toBe('plain')
  expect(unmarked.config.secret_env).toBeUndefined()

  // The CLI configures a secret from JSON the same way.
  const cli = await profile.cli(
    'service',
    'configure',
    workspace.id,
    'job',
    JSON.stringify({ ...base, env: { TOKEN: 'from-cli' }, secret_env: ['TOKEN'] }),
    '3',
  )
  expect(cli.code).toBe(0)
  expect(JSON.stringify(cli.json)).not.toContain('from-cli')
  const started = await profile.call('service.start', { workspace_id: workspace.id, name: 'job' })
  expect(started.service.config.env.TOKEN).toBe(REDACTED)
  // The print program exits after reporting its ADE_* variables; the secret itself is not echoed.
  await expect
    .poll(async () => (await profile.call('service.list', { workspace_id: workspace.id })).states.job?.state, {
      timeout: 15_000,
    })
    .toBe('exited')
  const inspected = await profile.call('service.inspect', { workspace_id: workspace.id, name: 'job' })
  expect(printedEnv(logText(inspected.logs))).toMatchObject({ ADE_SERVICE_NAME: 'job' })
  expect(JSON.stringify(inspected)).not.toContain('from-cli')
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'job' })
})
