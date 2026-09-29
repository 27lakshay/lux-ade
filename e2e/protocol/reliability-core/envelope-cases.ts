// The effect commands whose receipts the daemon's envelope keeps
// (crates/ade-daemon/src/envelope.rs), each described once for the R001 and
// R002 checks in envelope.spec.ts:
//
// - `request` builds the command; `altered` changes one payload field.
// - `observe` reads the command's effect as a JSON value that one execution
//   changes and a replay leaves alone.
// - `reset`, for a command that converges on a target state, undoes the effect
//   under another operation ID. A rerun of the original ID would then show up
//   as a changed observation.
// - `reconciles` says the daemon can prove the effect from the current state
//   after a crash, so an interrupted command settles instead of staying unknown.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  expect,
  prompts,
  send,
  startConversation,
  waitForIdle,
  type AdeHarness,
  type ScratchProfile,
  type ScratchRepo,
} from '../fixtures'
import {
  configureService,
  nodeService,
  serviceState,
  startForeignListener,
  waitForReadiness,
  writeServicePrograms,
} from '../fixtures/services'
import { settledExit, terminalMetrics, TerminalStream } from '../fixtures/terminals'
import { register, settled } from '../worktrees/lifecycle'

export type Context = { ade: AdeHarness; profile: ScratchProfile; repo: ScratchRepo }
export type Fields = Record<string, unknown>

export type EnvelopeCase<S = any> = {
  op: string
  setup(ctx: Context): Promise<S>
  request(state: S, altered: boolean): Fields
  observe(ctx: Context, state: S): Promise<unknown>
  reset?(ctx: Context, state: S): Promise<void>
  reconciles?: boolean
}

let setupNumber = 0
/** A fresh operation ID for a setup or reset step, never one a check uses. */
export function stepId(label: string): string {
  return `core-step-${label}-${process.pid}-${++setupNumber}`
}

export async function call(profile: ScratchProfile, op: string, request: Fields): Promise<any> {
  return profile.call(op as never, request as never)
}

// --- Conversations ------------------------------------------------------------

async function conversation(ctx: Context, conversationId: string) {
  return (await ctx.profile.call('conversation.get', { conversation_id: conversationId, limit: 1 })).conversation
}

async function mockCount(ctx: Context, method: string): Promise<number> {
  return (await ctx.profile.mockCalls('codex')).filter((entry) => entry.method === method).length
}

/** A Codex Conversation whose Agent has finished one turn and is still connected. */
async function connected(ctx: Context): Promise<string> {
  const { conversationId } = await startConversation(ctx.profile, 'codex')
  await send(ctx.profile, conversationId, prompts.turn)
  await waitForIdle(ctx.profile, conversationId)
  return conversationId
}

async function disconnect(ctx: Context, conversationId: string): Promise<void> {
  await ctx.profile.call('agent.disconnect', { operation_id: stepId('disconnect'), conversation_id: conversationId })
  await expect.poll(async () => (await conversation(ctx, conversationId)).status).toBe('disconnected')
}

// --- Terminals ----------------------------------------------------------------

type Terminals = { workspaceId: string; terminalId: string; otherId: string }

async function extraTerminal(ctx: Context, workspaceId: string): Promise<string> {
  const { terminal_id: terminalId } = await ctx.profile.call('terminal.create', {
    workspace_id: workspaceId,
    operation_id: stepId('terminal'),
  })
  // Attaching starts the shell.
  const stream = TerminalStream.open(ctx.profile, workspaceId, terminalId)
  await stream.snapshot()
  stream.close()
  await expect.poll(async () => (await terminalMetrics(ctx.profile, workspaceId, terminalId))?.shell_running).toBe(true)
  return terminalId
}

async function stopTerminal(ctx: Context, workspaceId: string, terminalId: string): Promise<void> {
  await ctx.profile.call('terminal.stop', {
    operation_id: stepId('stop'),
    workspace_id: workspaceId,
    terminal_id: terminalId,
  })
  await settledExit(ctx.profile, workspaceId, terminalId)
}

async function terminals(ctx: Context, stopped: boolean): Promise<Terminals> {
  const { workspace } = await ctx.profile.call('workspace.open', { path: ctx.profile.defaultWorkspaceRoot })
  const terminalId = await extraTerminal(ctx, workspace.id)
  const otherId = await extraTerminal(ctx, workspace.id)
  if (stopped) {
    await stopTerminal(ctx, workspace.id, terminalId)
    await stopTerminal(ctx, workspace.id, otherId)
  }
  return { workspaceId: workspace.id, terminalId, otherId }
}

/** Whether the shell runs, and which shell run it is: a restart makes a new one. */
async function shell(ctx: Context, state: Terminals) {
  const metrics = await terminalMetrics(ctx.profile, state.workspaceId, state.terminalId)
  return { running: metrics?.shell_running ?? null, run: metrics?.run_id ?? null }
}

/** The settled shell state, once any stop in flight has finished verifying. */
async function settledShell(ctx: Context, state: Terminals) {
  await expect
    .poll(async () => {
      const metrics = await terminalMetrics(ctx.profile, state.workspaceId, state.terminalId)
      return metrics?.shell_running === true || metrics?.exit_status?.verifying !== true
    })
    .toBe(true)
  return shell(ctx, state)
}

const terminalRequest = (state: Terminals, altered: boolean) => ({
  workspace_id: state.workspaceId,
  terminal_id: altered ? state.otherId : state.terminalId,
})

// --- Services -----------------------------------------------------------------

type Services = { workspaceId: string; revision: number }

async function services(ctx: Context, start: boolean): Promise<Services> {
  const { workspace } = await ctx.profile.call('workspace.open', { path: ctx.repo.path })
  const files = await writeServicePrograms(ctx.repo.path)
  const web = await configureService(ctx.profile, workspace.id, 'web', nodeService(files.server))
  await configureService(ctx.profile, workspace.id, 'api', nodeService(files.server))
  if (start) await startService(ctx, workspace.id)
  return { workspaceId: workspace.id, revision: web.revision }
}

async function startService(ctx: Context, workspaceId: string): Promise<void> {
  await ctx.profile.call('service.start', { operation_id: stepId('start'), workspace_id: workspaceId, name: 'web' })
  await waitForReadiness(ctx.profile, workspaceId, 'web', 'tcp_listening')
}

async function stopService(ctx: Context, workspaceId: string): Promise<void> {
  await ctx.profile.call('service.stop', { operation_id: stepId('stop'), workspace_id: workspaceId, name: 'web' })
}

type Route = { workspaceId: string; route: Record<string, any>; fields: Fields }

async function proxyRoute(ctx: Context): Promise<Route> {
  const { workspaceId } = await services(ctx, true)
  const route = await ctx.profile.call('service.proxy.ensure', {
    workspace_id: workspaceId,
    name: 'web',
    port_variable: 'PORT',
  })
  return {
    workspaceId,
    route,
    fields: {
      workspace_id: workspaceId,
      name: 'web',
      port_variable: 'PORT',
      expected_route_id: route.route_id,
      expected_service_identity: route.service_identity,
      expected_target_port: route.target_port,
      expected_proxy_port: route.port,
    },
  }
}

async function routeOf(ctx: Context, workspaceId: string) {
  return ctx.profile
    .call('service.proxy.inspect', { workspace_id: workspaceId, name: 'web', port_variable: 'PORT' })
    .then(
      (route) => ({ identity: route.service_identity, port: route.target_port, url: route.url }),
      (error: Error) => ({ error: /./.test(error.message) }),
    )
}

async function recoveryStatus(ctx: Context) {
  return (await ctx.profile.call('service.proxy.recovery.inspect', {})).status
}

// --- Scripts ------------------------------------------------------------------

type Scripts = { workspaceId: string; runId: string; otherId: string }

async function writeScripts(repo: ScratchRepo): Promise<void> {
  await mkdir(join(repo.path, '.ade'), { recursive: true })
  await mkdir(join(repo.path, 'tools'), { recursive: true })
  await writeFile(join(repo.path, 'tools/hold.mjs'), 'setInterval(() => {}, 1 << 30)\n')
  await writeFile(join(repo.path, 'tools/greet.mjs'), "console.log('hello')\n")
  const recipe = (file: string) => ({ program: process.execPath, args: [join(repo.path, file)], cwd: '.' })
  await writeFile(
    join(repo.path, '.ade/scripts.json'),
    JSON.stringify({
      schema_version: 1,
      scripts: { hold: recipe('tools/hold.mjs'), greet: recipe('tools/greet.mjs') },
    }),
  )
}

async function scriptRuns(ctx: Context, workspaceId: string) {
  return (await ctx.profile.call('script.runs', { workspace_id: workspaceId })).runs as Array<{
    run_id: string
    name: string
    state: string
  }>
}

async function scripts(ctx: Context, stopped: boolean): Promise<Scripts> {
  await writeScripts(ctx.repo)
  const { workspace } = await ctx.profile.call('workspace.open', { path: ctx.repo.path })
  const start = async () => {
    const run = await ctx.profile.call('script.start', {
      operation_id: stepId('script'),
      workspace_id: workspace.id,
      name: 'hold',
    })
    if (stopped) {
      await ctx.profile.call('script.stop', {
        operation_id: stepId('script-stop'),
        workspace_id: workspace.id,
        run_id: run.run_id,
      })
    }
    return run.run_id
  }
  return { workspaceId: workspace.id, runId: await start(), otherId: await start() }
}

const scriptRequest = (state: Scripts, altered: boolean) => ({
  workspace_id: state.workspaceId,
  run_id: altered ? state.otherId : state.runId,
})

// --- The cases ----------------------------------------------------------------

export const envelopeCases: EnvelopeCase[] = [
  {
    op: 'conversation.create',
    setup: async (ctx) => ({
      workspaceId: (await ctx.profile.call('workspace.open', { path: ctx.profile.defaultWorkspaceRoot })).workspace.id,
    }),
    request: (state: { workspaceId: string }, altered) => ({
      workspace_id: state.workspaceId,
      provider: 'codex',
      title: altered ? 'Another title' : 'Reliability',
    }),
    observe: async (ctx) =>
      (await ctx.profile.call('catalog.get', {})).catalog.conversations.filter((entry) => entry.title === 'Reliability')
        .length,
  },
  {
    op: 'queue.pause',
    setup: async (ctx) => (await startConversation(ctx.profile, 'codex')).conversationId,
    request: (conversationId: string, altered) => ({ conversation_id: conversationId, paused: !altered }),
    observe: async (ctx, conversationId: string) => (await conversation(ctx, conversationId)).queue_paused,
    reset: async (ctx, conversationId: string) => {
      await ctx.profile.call('queue.pause', {
        operation_id: stepId('unpause'),
        conversation_id: conversationId,
        paused: false,
      })
    },
    reconciles: true,
  },
  {
    op: 'agent.cancel',
    setup: async (ctx) => {
      const { conversationId } = await startConversation(ctx.profile, 'codex')
      await send(ctx.profile, conversationId, prompts.hold)
      let turnId = ''
      await expect
        .poll(async () => {
          const current = await conversation(ctx, conversationId)
          turnId = current.active_turn_id ?? ''
          return current.status === 'running' && turnId !== ''
        })
        .toBe(true)
      return { conversationId, turnId }
    },
    request: (state: { conversationId: string; turnId: string }, altered) => ({
      conversation_id: state.conversationId,
      turn_id: altered ? 'turn-another' : state.turnId,
    }),
    observe: (ctx) => mockCount(ctx, 'turn/interrupt'),
  },
  {
    op: 'agent.resume',
    setup: async (ctx) => {
      const conversationId = await connected(ctx)
      const otherId = (await startConversation(ctx.profile, 'codex')).conversationId
      await disconnect(ctx, conversationId)
      return { conversationId, otherId }
    },
    request: (state: { conversationId: string; otherId: string }, altered) => ({
      conversation_id: altered ? state.otherId : state.conversationId,
    }),
    observe: (ctx) => mockCount(ctx, 'thread/resume'),
  },
  {
    op: 'agent.disconnect',
    setup: async (ctx) => ({
      conversationId: await connected(ctx),
      otherId: (await startConversation(ctx.profile, 'codex')).conversationId,
    }),
    request: (state: { conversationId: string; otherId: string }, altered) => ({
      conversation_id: altered ? state.otherId : state.conversationId,
    }),
    observe: async (ctx, state: { conversationId: string }) =>
      (await conversation(ctx, state.conversationId)).status === 'disconnected',
    reset: async (ctx, state: { conversationId: string }) => {
      await ctx.profile.call('agent.resume', { operation_id: stepId('resume'), conversation_id: state.conversationId })
      await expect.poll(async () => (await conversation(ctx, state.conversationId)).status).not.toBe('disconnected')
    },
    reconciles: true,
  },
  {
    op: 'account.create',
    setup: async () => ({}),
    request: (_state, altered) => ({ provider: 'codex', name: altered ? 'Another' : 'Reliability' }),
    observe: async (ctx) =>
      (await ctx.profile.call('account.list', {})).accounts.filter((account) => account.name === 'Reliability').length,
  },
  {
    op: 'terminal.restart',
    setup: (ctx) => terminals(ctx, true),
    request: terminalRequest,
    observe: settledShell,
    reset: (ctx, state: Terminals) => stopTerminal(ctx, state.workspaceId, state.terminalId),
  },
  {
    op: 'terminal.stop',
    setup: (ctx) => terminals(ctx, false),
    request: terminalRequest,
    observe: settledShell,
    reset: async (ctx, state: Terminals) => {
      await ctx.profile.call('terminal.restart', { operation_id: stepId('restart'), ...terminalRequest(state, false) })
      await expect.poll(async () => (await shell(ctx, state)).running).toBe(true)
    },
    reconciles: true,
  },
  {
    op: 'terminal.retire',
    setup: (ctx) => terminals(ctx, true),
    request: terminalRequest,
    observe: async (ctx, state: Terminals) =>
      (await ctx.profile.call('catalog.get', {})).catalog.terminals.some(
        (terminal) => terminal.workspace_id === state.workspaceId && terminal.id === state.terminalId,
      ),
    reconciles: true,
  },
  {
    // Daemon-authority ticket 04: an idle running shell closes without force.
    op: 'terminal.close',
    setup: (ctx) => terminals(ctx, false),
    request: (state: Terminals, altered) => ({ terminal_id: altered ? state.otherId : state.terminalId }),
    observe: async (ctx, state: Terminals) =>
      (await ctx.profile.call('catalog.get', {})).catalog.terminals.some((entry) => entry.id === state.terminalId),
    reconciles: true,
  },
  {
    op: 'service.start',
    setup: (ctx) => services(ctx, false),
    request: (state: Services, altered) => ({ workspace_id: state.workspaceId, name: altered ? 'api' : 'web' }),
    observe: (ctx, state: Services) => serviceState(ctx.profile, state.workspaceId, 'web'),
    reset: (ctx, state: Services) => stopService(ctx, state.workspaceId),
  },
  {
    op: 'service.stop',
    setup: (ctx) => services(ctx, true),
    request: (state: Services, altered) => ({ workspace_id: state.workspaceId, name: altered ? 'api' : 'web' }),
    observe: (ctx, state: Services) => serviceState(ctx.profile, state.workspaceId, 'web'),
    reset: (ctx, state: Services) => startService(ctx, state.workspaceId),
  },
  {
    op: 'service.remove',
    setup: (ctx) => services(ctx, false),
    request: (state: Services, altered) => ({
      workspace_id: state.workspaceId,
      name: 'web',
      revision: altered ? state.revision + 1 : state.revision,
    }),
    observe: async (ctx, state: Services) =>
      (await ctx.profile.call('service.list', { workspace_id: state.workspaceId })).services.filter(
        (service) => service.name === 'web',
      ).length,
  },
  {
    op: 'service.proxy.remap',
    setup: async (ctx) => {
      const { workspace } = await ctx.profile.call('workspace.open', { path: ctx.repo.path })
      const files = await writeServicePrograms(ctx.repo.path)
      const original = await configureService(ctx.profile, workspace.id, 'web', nodeService(files.server))
      const route = await ctx.profile.call('service.proxy.ensure', {
        workspace_id: workspace.id,
        name: 'web',
        port_variable: 'PORT',
      })
      await ctx.profile.call('service.remove', {
        operation_id: stepId('remove'),
        workspace_id: workspace.id,
        name: 'web',
        revision: original.revision,
      })
      const replacement = await configureService(ctx.profile, workspace.id, 'web', nodeService(files.server))
      return {
        workspaceId: workspace.id,
        fields: {
          workspace_id: workspace.id,
          name: 'web',
          port_variable: 'PORT',
          expected_service_identity: replacement.identity,
          expected_target_port: replacement.ports.PORT,
          expected_route_identity: route.service_identity,
          expected_route_port: route.target_port,
        },
      }
    },
    request: (state: { fields: Fields }, altered) => ({
      ...state.fields,
      ...(altered ? { expected_route_port: (state.fields.expected_route_port as number) + 1 } : {}),
    }),
    observe: (ctx, state: { workspaceId: string }) => routeOf(ctx, state.workspaceId),
  },
  {
    op: 'service.proxy.retire',
    setup: proxyRoute,
    request: (state: Route, altered) => ({
      ...state.fields,
      ...(altered ? { expected_proxy_port: state.route.port + 1 } : {}),
    }),
    observe: (ctx, state: Route) => routeOf(ctx, state.workspaceId),
  },
  {
    op: 'service.proxy.recovery.retry',
    setup: async (ctx) => {
      const { workspace } = await ctx.profile.call('workspace.open', { path: ctx.repo.path })
      const files = await writeServicePrograms(ctx.repo.path)
      await configureService(ctx.profile, workspace.id, 'web', nodeService(files.server))
      const route = await ctx.profile.call('service.proxy.ensure', {
        workspace_id: workspace.id,
        name: 'web',
        port_variable: 'PORT',
      })
      // A foreign process takes the stable port while the runtime is replaced.
      await ctx.profile.killRuntime()
      const foreign = await startForeignListener(ctx.ade.ledger, route.port)
      try {
        await ctx.profile.restartDaemon()
        await expect.poll(() => recoveryStatus(ctx)).toBe('degraded')
      } finally {
        await foreign.close()
      }
      return {
        fields: {
          workspace_id: workspace.id,
          name: 'web',
          port_variable: 'PORT',
          expected_route_id: route.route_id,
          expected_service_identity: route.service_identity,
          expected_target_port: route.target_port,
          expected_proxy_port: route.port,
        },
      }
    },
    request: (state: { fields: Fields }, altered) => ({
      ...state.fields,
      ...(altered ? { expected_proxy_port: (state.fields.expected_proxy_port as number) + 1 } : {}),
    }),
    observe: (ctx) => recoveryStatus(ctx),
  },
  {
    op: 'service.proxy.recovery.reset',
    setup: async (ctx) => {
      const { workspace } = await ctx.profile.call('workspace.open', { path: ctx.repo.path })
      const files = await writeServicePrograms(ctx.repo.path)
      await configureService(ctx.profile, workspace.id, 'web', nodeService(files.server))
      await ctx.profile.call('service.proxy.ensure', { workspace_id: workspace.id, name: 'web', port_variable: 'PORT' })
      await ctx.profile.killRuntime()
      await writeFile(join(ctx.profile.dataDirectory, 'service-proxies.json'), '{"not": "a registry"')
      await ctx.profile.restartDaemon()
      const recovery = await ctx.profile.call('service.proxy.recovery.inspect', {})
      expect(recovery.status).toBe('corrupt')
      return { sha: recovery.registry_sha256 as string }
    },
    request: (state: { sha: string }, altered) => ({ expected_registry_sha256: altered ? '0'.repeat(64) : state.sha }),
    observe: (ctx) => recoveryStatus(ctx),
  },
  {
    op: 'worktree.adopt',
    setup: async (ctx) => {
      const repositoryId = await register(ctx.profile, ctx.repo)
      const path = join(dirname(ctx.repo.path), 'external')
      const other = join(dirname(ctx.repo.path), 'external-other')
      await ctx.repo.git('worktree', 'add', '--quiet', '-b', 'external', path)
      await ctx.repo.git('worktree', 'add', '--quiet', '-b', 'external-other', other)
      // The lifecycle lists linked trees it has observed.
      const refresh = stepId('refresh')
      await ctx.profile.call('worktree.refresh', { repository_id: repositoryId, operation_id: refresh })
      await settled(ctx.profile, repositoryId, refresh)
      expect(
        (await ctx.profile.call('worktree.get', { repository_id: repositoryId })).worktrees.find(
          (tree) => tree.path === path,
        ),
      ).toMatchObject({ ade_owned: false })
      return { repositoryId, path, other }
    },
    request: (state: { repositoryId: string; path: string; other: string }, altered) => {
      const path = altered ? state.other : state.path
      return { repository_id: state.repositoryId, path, confirm_path: path }
    },
    observe: async (ctx, state: { repositoryId: string; path: string }) =>
      (await ctx.profile.call('worktree.get', { repository_id: state.repositoryId })).worktrees.find(
        (tree) => tree.path === state.path,
      )?.ade_owned ?? null,
  },
  {
    op: 'script.start',
    setup: async (ctx) => {
      await writeScripts(ctx.repo)
      return { workspaceId: (await ctx.profile.call('workspace.open', { path: ctx.repo.path })).workspace.id }
    },
    request: (state: { workspaceId: string }, altered) => ({
      workspace_id: state.workspaceId,
      name: altered ? 'greet' : 'hold',
    }),
    observe: async (ctx, state: { workspaceId: string }) =>
      (await scriptRuns(ctx, state.workspaceId)).filter((run) => run.name === 'hold').length,
  },
  {
    op: 'script.stop',
    setup: (ctx) => scripts(ctx, false),
    request: scriptRequest,
    observe: async (ctx, state: Scripts) =>
      (await scriptRuns(ctx, state.workspaceId)).find((run) => run.run_id === state.runId)?.state ?? null,
  },
  {
    op: 'script.retire',
    setup: (ctx) => scripts(ctx, true),
    request: scriptRequest,
    observe: async (ctx, state: Scripts) =>
      (await scriptRuns(ctx, state.workspaceId)).some((run) => run.run_id === state.runId),
  },
]
