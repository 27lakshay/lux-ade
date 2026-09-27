// Effect commands whose own handlers keep their receipts, beyond the ones
// reliability-a proved (`../reliability-a/effects.ts`). Each is described in
// that file's `EffectCase` shape and checked by receipts.spec.ts:
//
// - Git mutations settled by the review worker: branch, stash, merge, fetch,
//   pull and push.
// - Worktree lifecycle jobs settled by the lifecycle worker: refresh, setup,
//   cleanup, resources.apply and carry.
// - Commands settled in their handler's own transaction: skill adoption and
//   placement, plugin install, uninstall and command invocation, delegation,
//   child and parent messages, parallel groups, HostResources recovery,
//   hook delivery retries, repository publishing and review prompts.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, prompts } from '../fixtures'
import { bareRemote } from '../fixtures/git-remotes'
import { installAndEnable, pluginLines, stagePlugin } from '../fixtures/plugins'
import type { Context, EffectCase } from '../reliability-a/effects'
import { createReady, register, settled as lifecycleSettled } from '../worktrees/lifecycle'

export type { Context, EffectCase }

// --- Review: Git mutations settled by a worker ------------------------------

type Review = { workspaceId: string; revision: string; indexToken: string; bare?: string }

async function reviewOutcome(context: Context, state: { workspaceId: string }, id: string) {
  let operation: Record<string, unknown> = {}
  await expect.poll(async () => {
    const reply = await context.profile.call('review.operation', { workspace_id: state.workspaceId, operation_id: id })
    operation = reply.operation as unknown as Record<string, unknown>
    return operation.status
  }, { timeout: 30_000 }).not.toBe('running')
  return operation
}

async function reviewState(context: Context, extra: Partial<Review> = {}): Promise<Review> {
  const workspaceId = (await context.profile.call('workspace.open', { path: context.repo.path })).workspace.id
  const status = await context.profile.call('review.status', { workspace_id: workspaceId, force: true })
  return { workspaceId, revision: status.revision, indexToken: status.index_token, ...extra }
}

const reviewBase = {
  pause: 'review' as const,
  outcome: (context: Context, state: Review, id: string) => reviewOutcome(context, state, id),
  unknown: (outcome: Record<string, unknown>) => outcome.status === 'interrupted',
}

async function count(context: Context, ...args: string[]): Promise<number> {
  return Number((await context.repo.git('rev-list', '--count', ...args)).trim())
}

/** A bare `origin` the workspace tracks, and a teammate commit already on it. */
async function withRemote(context: Context, teammateCommit: boolean): Promise<string> {
  const bare = await bareRemote(context.repo, join(context.ade.root, 'remotes', 'origin.git'), {})
  await context.repo.git('remote', 'add', 'origin', `file://${bare}`)
  await context.repo.git('fetch', '--quiet', 'origin')
  await context.repo.git('branch', '--quiet', '--set-upstream-to=origin/main', 'main')
  if (teammateCommit) {
    const mate = join(context.ade.root, 'teammate')
    await context.repo.git('clone', '--quiet', `file://${bare}`, mate)
    await writeFile(join(mate, 'mate.txt'), 'from a teammate\n')
    await context.repo.git('-C', mate, 'add', 'mate.txt')
    await context.repo.git('-C', mate, '-c', 'user.name=Mate', '-c', 'user.email=mate@example.invalid', 'commit',
      '--quiet', '-m', 'Teammate change')
    await context.repo.git('-C', mate, 'push', '--quiet', 'origin', 'HEAD:main')
  }
  return bare
}

// --- Worktree lifecycle: jobs settled by a worker ---------------------------

type Lifecycle = { repositoryId: string; path: string; other: string; marker?: string; log?: string }

async function lifecycleOutcome(context: Context, state: { repositoryId: string }, id: string) {
  let operation: Record<string, unknown> = {}
  await expect.poll(async () => {
    const reply = await context.profile.call('worktree.operation', { repository_id: state.repositoryId, operation_id: id })
    operation = reply.operation as unknown as Record<string, unknown>
    return operation.status
  }, { timeout: 30_000 }).not.toBe('running')
  return operation
}

const lifecycleBase = {
  pause: 'worktree' as const,
  outcome: (context: Context, state: { repositoryId: string }, id: string) => lifecycleOutcome(context, state, id),
  unknown: (outcome: Record<string, unknown>) => outcome.status === 'interrupted',
}

let treeNumber = 0
async function trees(context: Context): Promise<Lifecycle> {
  const repositoryId = await register(context.profile, context.repo)
  return { repositoryId, path: await createReady(context.profile, repositoryId, { name: `core-${++treeNumber}` }),
    other: await createReady(context.profile, repositoryId, { name: `core-${++treeNumber}` }) }
}

const sh = (name: string, script: string) => ({ name, command: ['/bin/sh', '-c', script] })

async function lines(path: string): Promise<number> {
  return readFile(path, 'utf8').then((text) => text.split('\n').filter(Boolean).length, () => 0)
}

export const domainCases: EffectCase[] = [
  {
    ...reviewBase, op: 'review.branch',
    setup: (context) => reviewState(context),
    request: (state: Review, id, altered) => ({ workspace_id: state.workspaceId, operation_id: id,
      name: altered ? 'core-other' : 'core-branch', create: true, index_token: state.indexToken }),
    effect: async (context) => (await context.repo.git('branch', '--list', 'core-branch')).trim() ? 1 : 0,
  },
  {
    ...reviewBase, op: 'review.stash',
    setup: async (context) => {
      await context.repo.dirty()
      return reviewState(context)
    },
    request: (state: Review, id, altered) => ({ workspace_id: state.workspaceId, operation_id: id, action: 'push',
      revision: state.revision, message: altered ? 'another stash' : 'core stash' }),
    effect: async (context) => (await context.repo.git('stash', 'list')).split('\n').filter(Boolean).length,
  },
  {
    ...reviewBase, op: 'review.merge',
    setup: async (context) => {
      await context.repo.git('checkout', '--quiet', '-b', 'feature')
      await context.repo.commit('Feature work', { 'feature.txt': 'feature\n' })
      await context.repo.git('checkout', '--quiet', 'main')
      return reviewState(context)
    },
    request: (state: Review, id, altered) => ({ workspace_id: state.workspaceId, operation_id: id, action: 'merge',
      target: altered ? 'main' : 'feature', index_token: state.indexToken }),
    effect: (context) => count(context, 'HEAD'),
  },
  {
    ...reviewBase, op: 'review.fetch',
    setup: async (context) => reviewState(context, { bare: await withRemote(context, true) }),
    request: (state: Review, id, altered) => ({ workspace_id: state.workspaceId, operation_id: id,
      remote: altered ? 'upstream' : 'origin' }),
    effect: (context) => count(context, 'origin/main'),
  },
  {
    ...reviewBase, op: 'review.pull',
    setup: async (context) => reviewState(context, { bare: await withRemote(context, true) }),
    request: (state: Review, id, altered) => ({ workspace_id: state.workspaceId, operation_id: id,
      index_token: altered ? `${state.indexToken}-other` : state.indexToken }),
    effect: (context) => count(context, 'HEAD'),
  },
  {
    ...reviewBase, op: 'review.push',
    setup: async (context) => {
      const bare = await withRemote(context, false)
      await context.repo.commit('Local change', { 'local.txt': 'local\n' })
      return reviewState(context, { bare })
    },
    request: (state: Review, id, altered) => ({ workspace_id: state.workspaceId, operation_id: id,
      index_token: state.indexToken, ...(altered ? { remote: 'origin' } : {}) }),
    effect: async (context, state: Review) => Number((await context.repo.git('--git-dir', state.bare!, 'rev-list',
      '--count', 'main')).trim()),
  },
  {
    ...lifecycleBase, op: 'worktree.cleanup',
    setup: trees,
    request: (state: Lifecycle, id, altered) => ({ repository_id: state.repositoryId, operation_id: id,
      paths: [altered ? state.other : state.path] }),
    effect: async (_context, state: Lifecycle) => existsSync(state.path) ? 0 : 1,
  },
  {
    ...lifecycleBase, op: 'worktree.resources.apply',
    setup: async (context) => {
      await context.repo.commit('Ignore the env file', { '.gitignore': '.env\n' })
      await context.repo.write('.env', 'SECRET=primary\n')
      const state = await trees(context)
      await context.profile.call('worktree.configure', { repository_id: state.repositoryId,
        config: { resources: [{ path: '.env', mode: 'copy' }] } })
      return state
    },
    request: (state: Lifecycle, id, altered) => ({ repository_id: state.repositoryId, operation_id: id,
      path: altered ? state.other : state.path }),
    effect: async (_context, state: Lifecycle) => existsSync(join(state.path, '.env')) ? 1 : 0,
  },
  {
    ...lifecycleBase, op: 'worktree.setup',
    setup: async (context) => {
      const repositoryId = await register(context.profile, context.repo)
      const marker = join(context.ade.root, 'setup-allowed')
      const log = join(context.ade.root, 'setup.log')
      await context.profile.call('worktree.configure', { repository_id: repositoryId, config: { setup: [
        sh('gate', `test -f '${marker}' || exit 3`),
        sh('count', `echo "$ADE_OPERATION_ID" >> '${log}'`),
      ] } })
      // Both trees fail setup until the marker exists; worktree.setup recovers one.
      const failed = async () => {
        const id = `core-create-${++treeNumber}`
        await context.profile.call('worktree.create', { repository_id: repositoryId, operation_id: id,
          name: `core-${treeNumber}` })
        const row = await lifecycleSettled(context.profile, repositoryId, id)
        expect(row, JSON.stringify(row)).toMatchObject({ status: 'failed', code: 'setup_hook_failed' })
        return row.worktree_path!
      }
      const state = { repositoryId, path: await failed(), other: await failed(), marker, log }
      await writeFile(marker, '')
      return state
    },
    request: (state: Lifecycle, id, altered) => ({ repository_id: state.repositoryId, operation_id: id,
      path: altered ? state.other : state.path }),
    effect: (_context, state: Lifecycle) => lines(state.log!),
  },
  {
    ...lifecycleBase, op: 'worktree.carry',
    setup: async (context) => {
      const state = await trees(context)
      await context.repo.write('README.md', 'carried change\n')
      return { ...state, head: await context.repo.head(), source: context.repo.path }
    },
    request: (state: Lifecycle & { head: string; source: string }, id, altered) => ({ repository_id: state.repositoryId,
      operation_id: id, source: state.source, target: state.path, paths: ['README.md'],
      expect_head: state.head, clean_source: !altered }),
    effect: async (context, state: Lifecycle) => (await context.repo.git('-C', state.path, 'diff', '--cached',
      '--name-only')).includes('README.md') ? 1 : 0,
  },
  {
    ...lifecycleBase, op: 'worktree.refresh',
    setup: async (context) => {
      const repositoryId = await register(context.profile, context.repo)
      const other = await register(context.profile, await context.ade.repo({ name: 'other' }))
      // A tree made outside ADE: the lifecycle lists it only after a refresh.
      const path = join(dirname(context.repo.path), 'outside')
      await context.repo.git('worktree', 'add', '--quiet', '-b', 'outside', path)
      return { repositoryId, path, other }
    },
    request: (state: Lifecycle, id, altered) => ({ repository_id: altered ? state.other : state.repositoryId,
      operation_id: id }),
    effect: async (context, state: Lifecycle) => (await context.profile.call('worktree.get',
      { repository_id: state.repositoryId })).worktrees.filter((tree) => tree.path === state.path).length,
  },
  {
    op: 'skill.adopt', outcome: settledReply, unknown: () => false,
    setup: async (context) => {
      const path = join(context.profile.home, '.claude/skills/core-notes')
      await writeSkill(path, 'core-notes')
      const reference = (await call(context, 'skill.discover', {})).references
        .find((entry: { entry: string }) => entry.entry === 'core-notes')
      return { path, hash: reference.content_hash as string }
    },
    request: (state: { path: string; hash: string }, id, altered) => ({ operation_id: id, path: state.path,
      expected_content_hash: altered ? '0'.repeat(64) : state.hash }),
    effect: async (context) => (await call(context, 'skill.list', {})).skills
      .filter((skill: { name: string }) => skill.name === 'core-notes').length,
  },
  {
    op: 'skill.place', outcome: settledReply, unknown: () => false,
    setup: async (context) => {
      const source = join(context.ade.root, 'sources', 'core-greet')
      await writeSkill(source, 'core-greet')
      const installed = await call(context, 'skill.install', { operation_id: 'core-setup-install', source_path: source })
      return { hash: installed.skill.content_hash as string }
    },
    request: (state: { hash: string }, id, altered) => ({ operation_id: id, name: 'core-greet',
      expected_content_hash: state.hash, provider: altered ? 'codex' : 'claude', scope: 'global' }),
    effect: async (context) => (await call(context, 'skill.inspect', { name: 'core-greet' })).projection
      .filter((entry: { provider: string; observed: string }) => entry.provider === 'claude'
        && entry.observed === 'adopted_unchanged').length,
  },
  {
    op: 'plugin.install', outcome: settledReply, unknown: () => false,
    setup: async (context) => ({ source: await stagePlugin(context.ade.root, 'backend') }),
    request: (state: { source: string }, id, altered) => ({ operation_id: id, source: { kind: 'local', path: state.source },
      ...(altered ? { expected_version: '9.9.9' } : {}) }),
    effect: (context) => plugins(context),
  },
  {
    op: 'plugin.uninstall', outcome: settledReply, unknown: () => false,
    setup: async (context) => {
      await context.profile.call('plugin.install', { operation_id: 'core-setup-install',
        source: { kind: 'local', path: await stagePlugin(context.ade.root, 'backend') } })
      return {}
    },
    request: (_state, id, altered) => ({ operation_id: id, plugin_id: altered ? 'e2e.missing' : 'e2e.backend' }),
    effect: async (context) => 1 - await plugins(context),
  },
  {
    op: 'plugin.command.invoke', outcome: settledReply, unknown: () => false,
    setup: async (context) => {
      const { pluginId, outDir } = await installAndEnable(context.profile, await stagePlugin(context.ade.root, 'backend'))
      // The held command finishes at once: its release file already exists.
      await writeFile(join(outDir, 'go'), '')
      return { pluginId, outDir }
    },
    request: (state: { pluginId: string }, id, altered) => ({ operation_id: id, plugin_id: state.pluginId,
      command_id: 'e2e.backend.hold', args: { release: 'go', note: altered ? 'another' : 'core' } }),
    effect: async (_context, state: { outDir: string }) => (await pluginLines(state.outDir, 'lifecycle.jsonl'))
      .filter((line) => line.event === 'hold-started').length,
  },
  {
    op: 'orchestration.delegate', outcome: settledReply, unknown: () => false,
    setup: (context) => parentConversation(context),
    request: (state: { parent: string }, id, altered) => ({ operation_id: id, parent_conversation_id: state.parent,
      caller: { kind: 'user' }, provider: 'codex', account: { mode: 'inherit' }, workspace: { mode: 'same' },
      task: altered ? `${prompts.turn} (another)` : prompts.turn }),
    effect: (context, state: { parent: string }) => children(context, state.parent),
  },
  {
    op: 'orchestration.child.send', outcome: settledReply, unknown: () => false,
    setup: (context) => delegatedChild(context),
    request: (state: Family, id, altered) => ({ operation_id: id, child_conversation_id: state.child,
      caller: { kind: 'user' }, text: altered ? 'another message' : 'core message' }),
    effect: (context, state: Family) => childMessages(context, state.child, 'to_child'),
  },
  {
    op: 'orchestration.parent.send', outcome: settledReply, unknown: () => false,
    setup: (context) => delegatedChild(context),
    request: (state: Family, id, altered) => ({ operation_id: id, child_conversation_id: state.child,
      caller: { kind: 'agent', conversation_id: state.child }, text: altered ? 'another report' : 'core report' }),
    effect: (context, state: Family) => childMessages(context, state.child, 'to_parent'),
  },
  {
    op: 'orchestration.group.start', outcome: settledReply, unknown: () => false,
    setup: (context) => parentConversation(context),
    request: (state: { parent: string }, id, altered) => ({ operation_id: id, parent_conversation_id: state.parent,
      caller: { kind: 'user' }, task: altered ? `${prompts.turn} (another)` : prompts.turn, runs: [
        { provider: 'codex', account: { mode: 'inherit' }, workspace: { mode: 'same' } },
        { provider: 'codex', account: { mode: 'inherit' }, workspace: { mode: 'same' } }] }),
    effect: async (context, state: { parent: string }) => (await context.profile.call('orchestration.groups',
      { parent_conversation_id: state.parent })).groups.length,
  },
  {
    op: 'resources.claim.resolve', outcome: settledReply, unknown: () => false,
    setup: quarantinedClaim,
    request: (state: Claim, id, altered) => ({ operation_id: id, claim_id: state.claimId,
      confirm_path: altered ? `${state.path}-other` : state.path }),
    effect: async (context, state: Claim) => 1 - (await context.profile.call('resources.inspect', { path: state.path }))
      .claims.filter((claim) => claim.id === state.claimId).length,
  },
  {
    op: 'resources.registry.accept', outcome: settledReply, unknown: () => false,
    setup: async (context) => {
      const registry = (await context.profile.call('resources.inspect', {})).registry.path
      // No process of this profile holds the registry while it is replaced by garbage.
      await context.profile.stop()
      await rm(`${registry}-wal`, { force: true })
      await rm(`${registry}-shm`, { force: true })
      await writeFile(registry, Buffer.alloc(8192, 'not a registry '))
      await context.profile.restartDaemon()
      expect((await context.profile.call('resources.inspect', {})).registry.state).toBe('blocked')
      return { registry }
    },
    request: (state: { registry: string }, id, altered) => ({ operation_id: id,
      confirm_registry: altered ? `${state.registry}.other` : state.registry }),
    effect: async (context) => (await context.profile.call('resources.inspect', {})).registry.state === 'ready' ? 1 : 0,
  },
  {
    op: 'hook.delivery.retry', outcome: settledReply, unknown: () => false,
    setup: async (context) => {
      const { pluginId, outDir } = await installAndEnable(context.profile, await stagePlugin(context.ade.root, 'backend'))
      // The fixture hook fails for a workspace whose root names fail-hook.
      const path = join(context.ade.root, 'hook-workspaces', 'fail-hook')
      await mkdir(path, { recursive: true })
      const { workspace } = await context.profile.call('workspace.open', { path })
      let effectId = ''
      await expect.poll(async () => {
        const delivery = (await context.profile.call('hook.delivery.list', { plugin_id: pluginId })).deliveries
          .find((entry) => (entry.payload as { root?: string }).root === workspace.root)
        effectId = delivery?.effect_id ?? ''
        return delivery?.status
      }, { timeout: 20_000 }).toBe('failed')
      return { effectId, outDir }
    },
    request: (state: { effectId: string }, id, altered) => ({ operation_id: id, effect_id: state.effectId,
      ...(altered ? { acknowledge_unknown: true } : {}) }),
    effect: async (_context, state: { effectId: string; outDir: string }) => (await pluginLines(state.outDir, 'hooks.jsonl'))
      .filter((line) => line.effect_id === state.effectId).length,
  },
  {
    op: 'repository.publish', outcome: settledReply, unknown: () => false,
    setup: async (context) => {
      const bare = await bareRemote(context.repo, join(context.ade.root, 'remotes', 'published.git'))
      const folder = join(context.ade.root, 'publish-me')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'index.txt'), 'published\n')
      return { bare, folder, url: pathToFileURL(bare).href }
    },
    request: (state: { folder: string; url: string }, id, altered) => ({ operation_id: id, path: state.folder,
      url: state.url, create_initial_commit: true, commit_message: altered ? 'Another import' : 'Initial import' }),
    effect: async (context, state: { bare: string }) => (await context.repo.git('--git-dir', state.bare, 'for-each-ref',
      '--format=%(objectname)', 'refs/heads/main')).trim() ? 1 : 0,
  },
  {
    // Identified by its send request ID, as agent.send is.
    op: 'agent.send_review', outcome: settledReply, unknown: () => false,
    setup: async (context) => {
      await context.repo.commit('Track a file', { 'tracked.txt': 'baseline\n' })
      await context.repo.write('tracked.txt', 'baseline\nfirst\n')
      const { workspace } = await context.profile.call('workspace.open', { path: context.repo.path })
      const { conversation } = await context.profile.call('conversation.create', { workspace_id: workspace.id,
        provider: 'codex' })
      const page = await call(context, 'review.diff_page', { workspace_id: workspace.id, path: 'tracked.txt', staged: false })
      const row = (page.rows as Array<{ kind: string; new_line: number | null; text: string; hunk: string }>)
        .find((item) => item.kind === 'added' && item.new_line === 2)!
      const feedback = { format: 'ade-review-feedback-v1', workspace_id: workspace.id, notes: [{ anchor: {
        workspace_id: workspace.id, path: 'tracked.txt', staged: false, revision: page.revision, token: page.token,
        hunk: row.hunk, line: 2, text: row.text }, note: 'Check this line' }] }
      return { conversationId: conversation.id, feedback }
    },
    request: (state: { conversationId: string; feedback: unknown }, id, altered) => ({ conversation_id: state.conversationId,
      request_id: id, text: altered ? 'Another review prompt' : 'Review tracked.txt line 2: Check this line',
      review_feedback: state.feedback }),
    effect: async (context) => (await context.profile.mockCalls('codex'))
      .filter((entry) => entry.method === 'turn/start').length,
  },
]

// --- Helpers for the synchronous cases ----------------------------------------

async function settledReply(_context: Context, _state: unknown, _id: string, reply: unknown) {
  return reply as Record<string, unknown>
}

async function call(context: Context, op: string, request: Record<string, unknown>): Promise<any> {
  return context.profile.call(op as never, request as never)
}

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: A reliability fixture.\n---\n\n# ${name}\n`)
}

async function plugins(context: Context): Promise<number> {
  return (await context.profile.call('plugin.list', {})).plugins.filter((plugin) => plugin.id === 'e2e.backend').length
}

async function parentConversation(context: Context): Promise<{ parent: string }> {
  const { workspace } = await context.profile.call('workspace.open', { path: context.profile.defaultWorkspaceRoot })
  const { conversation } = await context.profile.call('conversation.create', { workspace_id: workspace.id,
    provider: 'codex' })
  return { parent: conversation.id }
}

async function children(context: Context, parent: string): Promise<number> {
  return (await context.profile.call('orchestration.children', { parent_conversation_id: parent })).children.length
}

type Family = { parent: string; child: string }

/** A parent and a delegated child whose task turn has finished. */
async function delegatedChild(context: Context): Promise<Family> {
  const { parent } = await parentConversation(context)
  const { child } = await context.profile.call('orchestration.delegate', { operation_id: 'core-setup-delegate',
    parent_conversation_id: parent, caller: { kind: 'user' }, provider: 'codex', account: { mode: 'inherit' },
    workspace: { mode: 'same' }, task: prompts.turn })
  await expect.poll(async () => (await context.profile.call('orchestration.child.wait', {
    child_conversation_id: child.child_conversation_id, timeout_ms: 0 })).state, { timeout: 20_000 }).toBe('settled')
  return { parent, child: child.child_conversation_id }
}

async function childMessages(context: Context, child: string, direction: string): Promise<number> {
  return (await context.profile.call('orchestration.child.messages', { child_conversation_id: child })).messages
    .filter((message) => (message as { direction: string }).direction === direction
      && (message as { operation_id: string }).operation_id !== 'core-setup-delegate').length
}

type Claim = { path: string; claimId: string }

/** A tree whose creation was interrupted by a daemon crash mid-setup: its create claim is quarantined. */
async function quarantinedClaim(context: Context): Promise<Claim> {
  const repositoryId = await register(context.profile, context.repo)
  const started = join(context.ade.root, 'setup-started')
  const release = join(context.ade.root, 'setup-release')
  await context.profile.call('worktree.configure', { repository_id: repositoryId, config: { setup: [
    sh('wait', `: > '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`),
  ] } })
  await context.profile.call('worktree.create', { repository_id: repositoryId, operation_id: 'core-setup-create',
    name: 'core-claimed' })
  await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true)
  const running = await context.profile.call('worktree.operation', { repository_id: repositoryId,
    operation_id: 'core-setup-create' })
  const path = (running.operation as unknown as { worktree_path: string }).worktree_path
  try {
    await context.profile.killDaemon()
  } finally {
    await writeFile(release, '')
  }
  await context.profile.restartDaemon()
  await lifecycleSettled(context.profile, repositoryId, 'core-setup-create')
  let claimId = ''
  await expect.poll(async () => {
    const claims = (await context.profile.call('resources.inspect', { path })).claims
      .filter((claim) => claim.path === path && claim.state === 'quarantined')
    claimId = claims[0]?.id ?? ''
    return claims.length
  }).toBe(1)
  return { path, claimId }
}

