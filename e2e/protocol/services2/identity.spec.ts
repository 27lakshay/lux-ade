// F088 and F090 host and workspace identity. Stable URLs and script runs name
// the execution host their workspace's placement resolves to, and the process
// they reach or start carries that workspace and host identity. Two workspaces
// with the same service or script name never cross. A remote host is refused
// through the placement contract; nothing falls back to, or is relocated from,
// the local host.
import { mkdir, writeFile } from 'node:fs/promises'
import type { PlacedResource } from '../../../packages/contracts/dist/index.js'
import { join } from 'node:path'
import { expect, test, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { printedEnv, writeEnvEchoPrograms } from '../fixtures/env-echo'
import { httpGet, logText, waitForReadiness } from '../fixtures/services'

const LOCAL = { kind: 'local' }

async function openEchoWorkspace(profile: ScratchProfile, repo: ScratchRepo) {
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const files = await writeEnvEchoPrograms(repo.path)
  await mkdir(join(repo.path, '.ade'), { recursive: true })
  await writeFile(
    join(repo.path, '.ade/scripts.json'),
    JSON.stringify({
      schema_version: 1,
      scripts: { identify: { program: process.execPath, args: [files.print], cwd: '.' } },
    }),
  )
  const service = (
    await profile.call('service.configure', {
      workspace_id: workspace.id,
      name: 'web',
      revision: 0,
      config: { program: process.execPath, args: [files.server], ports: ['PORT'] },
    })
  ).service
  return { workspace, service }
}

async function resolveHost(profile: ScratchProfile, resource: PlacedResource) {
  return (await profile.call('placement.resolve', { resource })).placement
}

test('stable URLs route to the service of their own workspace on the host its placement names', async ({
  ade,
  profile,
}) => {
  const first = await openEchoWorkspace(profile, await ade.repo({ name: 'first' }))
  const second = await openEchoWorkspace(profile, await ade.repo({ name: 'second' }))
  for (const { workspace } of [first, second]) {
    await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
    await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  }

  const routes = []
  for (const { workspace, service } of [first, second]) {
    const route = await profile.call('service.proxy.ensure', {
      workspace_id: workspace.id,
      name: 'web',
      port_variable: 'PORT',
    })
    // The route names its execution host, which is the service's and its workspace's placement.
    expect(route).toMatchObject({
      execution_host: LOCAL,
      service_identity: service.identity,
      target_port: service.ports.PORT,
      scope: 'local_private',
    })
    expect(await resolveHost(profile, { kind: 'service', workspace_id: workspace.id, name: 'web' })).toMatchObject({
      host: LOCAL,
      source: 'local_state',
    })
    expect(await resolveHost(profile, { kind: 'workspace', workspace_id: workspace.id })).toMatchObject({
      host: LOCAL,
      source: 'local_state',
    })
    expect(
      await profile.call('service.proxy.inspect', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
    ).toEqual(route)
    routes.push(route)
  }
  expect(routes[0].port).not.toBe(routes[1].port)

  // Each URL reaches the process of its own workspace, which knows its workspace, service and host.
  for (const [index, { workspace, service }] of [first, second].entries()) {
    const reply = await httpGet(routes[index].url!)
    expect(reply.json).toMatchObject({
      port: service.ports.PORT,
      env: {
        ADE_WORKSPACE_ID: workspace.id,
        ADE_WORKSPACE_ROOT: workspace.root,
        ADE_SERVICE_NAME: 'web',
        ADE_SERVICE_HOST: service.hostname,
        ADE_EXECUTION_HOST: 'local',
      },
    })
  }
  const cli = await profile.cli('service', 'url-inspect', first.workspace.id, 'web', 'PORT')
  expect(cli.json).toMatchObject({ route_id: routes[0].route_id, execution_host: LOCAL })

  // The route keeps its host and target across a daemon restart.
  await profile.restartDaemon('kill')
  expect(
    await profile.call('service.proxy.inspect', {
      workspace_id: second.workspace.id,
      name: 'web',
      port_variable: 'PORT',
    }),
  ).toEqual(routes[1])
  expect((await httpGet(routes[1].url!)).json).toMatchObject({ env: { ADE_WORKSPACE_ID: second.workspace.id } })

  for (const { workspace } of [first, second])
    await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('a remote host is refused through placement and never replaces the local route', async ({ profile, repo }) => {
  const { workspace, service } = await openEchoWorkspace(profile, repo)
  await profile.call('service.start', { workspace_id: workspace.id, name: 'web' })
  await waitForReadiness(profile, workspace.id, 'web', 'tcp_listening')
  const route = await profile.call('service.proxy.ensure', {
    workspace_id: workspace.id,
    name: 'web',
    port_variable: 'PORT',
  })
  const remote = { kind: 'remote', host_id: 'build-box' } as const

  // The only host offered is this one; an unknown remote host takes no services or terminals.
  const hosts = await profile.call('placement.hosts', {})
  expect(hosts.hosts.map((entry) => entry.host)).toEqual([LOCAL])
  for (const resource of ['service', 'terminal'] as const) {
    const decision = await profile.call('placement.check', { host: remote, resource, workspace_id: workspace.id })
    expect(decision).toMatchObject({ admitted: false })
    expect(JSON.stringify(decision)).not.toMatch(/"kind":"local"/)
  }
  // The held service cannot be recorded elsewhere, so routing cannot be redirected.
  await expect(
    profile.call('placement.record', {
      resource: { kind: 'service', workspace_id: workspace.id, name: 'web' },
      host: remote,
    }),
  ).rejects.toThrow()
  await expect(
    profile.call('placement.record', { resource: { kind: 'workspace', workspace_id: workspace.id }, host: remote }),
  ).rejects.toThrow()
  expect((await profile.call('placement.list', {})).placements).toEqual([])

  // A workspace this daemon neither holds nor has recorded has no services to route.
  await expect(
    profile.call('service.proxy.ensure', { workspace_id: 'workspace_elsewhere', name: 'web', port_variable: 'PORT' }),
  ).rejects.toThrow()
  await expect(
    profile.call('script.start', { workspace_id: 'workspace_elsewhere', name: 'identify' }),
  ).rejects.toThrow()

  // The local route is unchanged and still reaches the local process.
  expect(
    await profile.call('service.proxy.inspect', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' }),
  ).toEqual(route)
  expect((await httpGet(route.url!)).json).toMatchObject({
    port: service.ports.PORT,
    env: { ADE_WORKSPACE_ID: workspace.id, ADE_EXECUTION_HOST: 'local' },
  })
  await profile.call('service.stop', { workspace_id: workspace.id, name: 'web' })
})

test('script runs carry their workspace and host identity and stay inside their workspace', async ({
  ade,
  profile,
}) => {
  const first = await openEchoWorkspace(profile, await ade.repo({ name: 'first' }))
  const second = await openEchoWorkspace(profile, await ade.repo({ name: 'second' }))
  const runs = []
  for (const { workspace } of [first, second]) {
    const run = await profile.call('script.start', { workspace_id: workspace.id, name: 'identify' })
    expect(run).toMatchObject({
      type: 'script_run',
      workspace_id: workspace.id,
      execution_host: LOCAL,
      name: 'identify',
    })
    runs.push(run)
  }

  for (const [index, { workspace }] of [first, second].entries()) {
    const runId = runs[index].run_id
    await expect
      .poll(
        async () =>
          printedEnv(
            logText((await profile.call('script.inspect', { workspace_id: workspace.id, run_id: runId })).output),
          ),
        { timeout: 20_000 },
      )
      .toBeDefined()
    const inspected = await profile.call('script.inspect', { workspace_id: workspace.id, run_id: runId })
    expect(inspected).toMatchObject({ workspace_id: workspace.id, execution_host: LOCAL })
    // The process was told exactly which workspace, host, script and run it is.
    expect(printedEnv(logText(inspected.output))).toMatchObject({
      ADE_WORKSPACE_ID: workspace.id,
      ADE_WORKSPACE_ROOT: workspace.root,
      ADE_EXECUTION_HOST: 'local',
      ADE_SCRIPT_NAME: 'identify',
      ADE_SCRIPT_RUN_ID: runId,
    })
    // The run is a terminal of its workspace on the local host.
    expect(
      await resolveHost(profile, { kind: 'terminal', workspace_id: workspace.id, terminal_id: runId }),
    ).toMatchObject({ host: LOCAL, source: 'local_state' })
    const listed = await profile.call('script.runs', { workspace_id: workspace.id })
    expect(listed).toMatchObject({ workspace_id: workspace.id, execution_host: LOCAL })
    expect(listed.runs.map((run) => run.run_id)).toEqual([runId])
  }

  // A run is only reachable through its own workspace.
  await expect(
    profile.call('script.inspect', { workspace_id: second.workspace.id, run_id: runs[0].run_id }),
  ).rejects.toThrow(/Script run is unavailable/)
  await expect(
    profile.call('script.stop', { workspace_id: second.workspace.id, run_id: runs[0].run_id }),
  ).rejects.toThrow(/Script run is unavailable/)
  await expect(
    resolveHost(profile, { kind: 'terminal', workspace_id: second.workspace.id, terminal_id: runs[0].run_id }),
  ).rejects.toThrow()

  // The CLI shows the same identity.
  const cli = await profile.cli('script', 'inspect', first.workspace.id, runs[0].run_id)
  expect(cli.json).toMatchObject({ workspace_id: first.workspace.id, execution_host: LOCAL })

  // After a daemon restart the runs keep their identity.
  await profile.restartDaemon('graceful')
  expect(
    await profile.call('script.inspect', { workspace_id: first.workspace.id, run_id: runs[0].run_id }),
  ).toMatchObject({ workspace_id: first.workspace.id, execution_host: LOCAL, run_id: runs[0].run_id })
})
