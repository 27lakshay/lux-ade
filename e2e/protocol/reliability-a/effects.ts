// One receipt contract, checked the same way for every effect command in the
// table below (architecture section 4, R001 and R002). Each case says how to
// build the command, how to read its settled outcome, and how to observe its
// external effect as a count that one execution raises by exactly one.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, type AdeHarness, type ScratchProfile, type ScratchRepo } from '../fixtures'

export type Context = { ade: AdeHarness; profile: ScratchProfile; repo: ScratchRepo }
type Fields = Record<string, unknown>

export type EffectCase<S = any> = {
  op: string
  /** Where a daemon crash can land between dispatch and settlement: the paused Git worker. */
  pause?: 'review' | 'worktree'
  setup(context: Context): Promise<S>
  /** The command under `id`; `altered` changes one payload field and nothing else. */
  request(state: S, id: string, altered: boolean): Fields
  /** The settled outcome of `id`, read back after `reply`. */
  outcome(context: Context, state: S, id: string, reply: unknown): Promise<Record<string, unknown>>
  /** Whether a settled outcome is an explicit unknown rather than a known result. */
  unknown(outcome: Record<string, unknown>): boolean
  /** A count that one execution raises by exactly one. */
  effect(context: Context, state: S): Promise<number>
}

export async function call(profile: ScratchProfile, op: string, request: Fields): Promise<any> {
  return profile.call(op as never, request as never)
}

/** Every environment switch the pause points need; nothing pauses until a case arms it. */
export function pauseEnvironment(root: string): Record<string, string> {
  return {
    ADE_E2E_WORKER_PAUSE_ENABLED: '1',
    ADE_E2E_REVIEW_PAUSE_DIR: join(root, 'pause-review'),
    ADE_E2E_WORKER_PAUSE_DIR: join(root, 'pause-worktree'),
  }
}

async function workspace(context: Context): Promise<string> {
  return (await context.profile.call('workspace.open', { path: context.repo.path })).workspace.id
}

// --- Review: Git mutations settled by a worker ------------------------------

type Review = { workspaceId: string; revision: string; indexToken: string; token: string }

async function reviewState(context: Context, stage: boolean): Promise<Review> {
  await context.repo.commit('Track files', { 'tracked.txt': 'one\n\nmiddle\n\nend\n', 'other.txt': 'other\n' })
  await context.repo.write('tracked.txt', 'one changed\n\nmiddle\n\nend\n')
  await context.repo.write('other.txt', 'other changed\n')
  if (stage) await context.repo.git('add', 'tracked.txt')
  const workspaceId = await workspace(context)
  const status = await context.profile.call('review.status', { workspace_id: workspaceId, force: true })
  const token = stage
    ? ''
    : (await context.profile.call('review.diff', { workspace_id: workspaceId, path: 'tracked.txt', staged: false }))
        .token
  return { workspaceId, revision: status.revision, indexToken: status.index_token, token }
}

async function reviewOutcome(context: Context, state: Review, id: string) {
  let operation: Record<string, unknown> = {}
  await expect
    .poll(
      async () => {
        const reply = await context.profile.call('review.operation', {
          workspace_id: state.workspaceId,
          operation_id: id,
        })
        operation = reply.operation
        return operation.status
      },
      { timeout: 30_000 },
    )
    .not.toBe('running')
  return operation
}

async function staged(context: Context, path: string): Promise<boolean> {
  return (await context.repo.git('diff', '--cached', '--name-only')).split('\n').includes(path)
}

const reviewBase = {
  pause: 'review' as const,
  outcome: (context: Context, state: Review, id: string) => reviewOutcome(context, state, id),
  unknown: (outcome: Record<string, unknown>) => outcome.status === 'interrupted',
}

// --- Worktree lifecycle: jobs settled by a worker ---------------------------

type Lifecycle = { repositoryId: string; path?: string }

async function lifecycleOutcome(context: Context, state: Lifecycle, id: string) {
  let operation: Record<string, unknown> = {}
  await expect
    .poll(
      async () => {
        const reply = await context.profile.call('worktree.operation', {
          repository_id: state.repositoryId,
          operation_id: id,
        })
        operation = reply.operation
        return operation.status
      },
      { timeout: 30_000 },
    )
    .not.toBe('running')
  return operation
}

async function worktreeBranches(context: Context, prefix: string): Promise<number> {
  const listed = await context.repo.git('worktree', 'list', '--porcelain')
  return listed.split('\n').filter((line) => line.startsWith(`branch refs/heads/${prefix}`)).length
}

const lifecycleBase = {
  pause: 'worktree' as const,
  outcome: (context: Context, state: Lifecycle, id: string) => lifecycleOutcome(context, state, id),
  unknown: (outcome: Record<string, unknown>) => outcome.status === 'interrupted',
}

// --- Synchronous effects -----------------------------------------------------

const settledReply = async (_context: Context, _state: unknown, _id: string, reply: unknown) =>
  reply as Record<string, unknown>

async function checkpoints(context: Context, workspaceId: string): Promise<number> {
  return (await context.profile.call('checkpoint.list', { workspace_id: workspaceId })).checkpoints.length
}

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A reliability fixture.\n---\n\n# ${name}\n`,
  )
}

async function exists(path: string): Promise<boolean> {
  return readFile(join(path, 'README.md')).then(
    () => true,
    () => false,
  )
}

export const effectCases: EffectCase[] = [
  {
    ...reviewBase,
    op: 'review.stage',
    setup: (context) => reviewState(context, false),
    request: (state: Review, id, altered) => ({
      workspace_id: state.workspaceId,
      operation_id: id,
      path: altered ? 'other.txt' : 'tracked.txt',
      revision: state.revision,
    }),
    effect: async (context) => Number(await staged(context, 'tracked.txt')),
  },
  {
    ...reviewBase,
    op: 'review.unstage',
    setup: (context) => reviewState(context, true),
    request: (state: Review, id, altered) => ({
      workspace_id: state.workspaceId,
      operation_id: id,
      path: altered ? 'other.txt' : 'tracked.txt',
      revision: state.revision,
    }),
    effect: async (context) => Number(!(await staged(context, 'tracked.txt'))),
  },
  {
    ...reviewBase,
    op: 'review.commit',
    setup: (context) => reviewState(context, true),
    request: (state: Review, id, altered) => ({
      workspace_id: state.workspaceId,
      operation_id: id,
      message: altered ? 'Another message' : 'Reliability commit',
      index_token: state.indexToken,
    }),
    effect: async (context) => Number(await context.repo.git('rev-list', '--count', 'HEAD')),
  },
  {
    ...reviewBase,
    op: 'review.discard',
    setup: (context) => reviewState(context, false),
    request: (state: Review, id, altered) => ({
      workspace_id: state.workspaceId,
      operation_id: id,
      path: altered ? 'other.txt' : 'tracked.txt',
      revision: state.revision,
      diff_token: state.token,
    }),
    effect: async (context) => Number((await context.repo.read('tracked.txt')) === 'one\n\nmiddle\n\nend\n'),
  },
  {
    ...reviewBase,
    op: 'review.hunk',
    setup: (context) => reviewState(context, false),
    request: (state: Review, id, altered) => ({
      workspace_id: state.workspaceId,
      operation_id: id,
      path: 'tracked.txt',
      token: state.token,
      hunk: altered ? 1 : 0,
    }),
    effect: async (context) => Number(await staged(context, 'tracked.txt')),
  },
  {
    ...lifecycleBase,
    op: 'worktree.create',
    setup: async (context) => ({
      repositoryId: (await context.profile.call('worktree.repository', { path: context.repo.path })).repository.id,
    }),
    request: (state: Lifecycle, id, altered) => ({
      repository_id: state.repositoryId,
      operation_id: id,
      branch: altered ? 'reliability-other' : 'reliability-tree',
    }),
    effect: (context) => worktreeBranches(context, 'reliability-tree'),
  },
  {
    ...lifecycleBase,
    op: 'worktree.remove',
    setup: async (context) => {
      const repositoryId = (await context.profile.call('worktree.repository', { path: context.repo.path })).repository
        .id
      const state: Lifecycle = { repositoryId }
      await context.profile.call('worktree.create', {
        repository_id: repositoryId,
        operation_id: 'setup-create',
        branch: 'reliability-removed',
      })
      const created = await lifecycleOutcome(context, state, 'setup-create')
      expect(created, JSON.stringify(created)).toMatchObject({ status: 'succeeded' })
      return { repositoryId, path: created.worktree_path as string }
    },
    request: (state: Lifecycle, id, altered) => ({
      repository_id: state.repositoryId,
      operation_id: id,
      path: state.path,
      ...(altered ? { delete_branch: 'merged' } : {}),
    }),
    effect: async (context) => 1 - (await worktreeBranches(context, 'reliability-removed')),
  },
  {
    ...lifecycleBase,
    op: 'worktree.switch',
    setup: async (context) => ({
      repositoryId: (await context.profile.call('worktree.repository', { path: context.repo.path })).repository.id,
    }),
    request: (state: Lifecycle, id, altered) => ({
      repository_id: state.repositoryId,
      operation_id: id,
      target: altered ? 'reliability-other' : 'reliability-switched',
      create: true,
    }),
    effect: (context) => worktreeBranches(context, 'reliability-switched'),
  },
  {
    op: 'terminal.create',
    outcome: settledReply,
    unknown: () => false,
    setup: async (context) => {
      const workspaceId = (await context.profile.call('workspace.open', { path: context.profile.defaultWorkspaceRoot }))
        .workspace.id
      return { workspaceId, otherId: await workspace(context) }
    },
    request: (state: { workspaceId: string; otherId: string }, id, altered) => ({
      operation_id: id,
      workspace_id: altered ? state.otherId : state.workspaceId,
    }),
    effect: async (context, state: { workspaceId: string }) =>
      (
        (await context.profile.call('catalog.get', {})).catalog.workspaces.find(
          (entry) => entry.id === state.workspaceId,
        )?.extra_terminals ?? []
      ).length,
  },
  {
    op: 'skill.remove',
    outcome: settledReply,
    unknown: () => false,
    setup: async (context) => {
      const source = join(context.ade.root, 'skills', 'reliability-skill')
      await writeSkill(source, 'reliability-skill')
      const installed = await call(context.profile, 'skill.install', {
        operation_id: 'setup-install',
        source_path: source,
      })
      return { hash: installed.skill.content_hash as string }
    },
    request: (state: { hash: string }, id, altered) => ({
      operation_id: id,
      name: 'reliability-skill',
      expected_content_hash: altered ? '0'.repeat(64) : state.hash,
    }),
    effect: async (context) =>
      1 -
      (await call(context.profile, 'skill.list', {})).skills.filter(
        (skill: { name: string }) => skill.name === 'reliability-skill',
      ).length,
  },
  {
    op: 'checkpoint.create',
    outcome: settledReply,
    unknown: () => false,
    setup: async (context) => {
      await context.repo.dirty()
      return { workspaceId: await workspace(context) }
    },
    request: (state: { workspaceId: string }, id, altered) => ({
      workspace_id: state.workspaceId,
      operation_id: id,
      label: altered ? 'another label' : 'reliability',
    }),
    effect: (context, state: { workspaceId: string }) => checkpoints(context, state.workspaceId),
  },
  {
    op: 'checkpoint.delete',
    outcome: settledReply,
    unknown: () => false,
    setup: async (context) => {
      await context.repo.dirty()
      const workspaceId = await workspace(context)
      const { checkpoint } = await context.profile.call('checkpoint.create', {
        operation_id: 'setup-checkpoint',
        workspace_id: workspaceId,
      })
      return {
        workspaceId,
        checkpointId: checkpoint.checkpoint_id,
        commit: checkpoint.commit,
        head: await context.repo.head(),
      }
    },
    request: (state: { workspaceId: string; checkpointId: string; commit: string; head: string }, id, altered) => ({
      workspace_id: state.workspaceId,
      operation_id: id,
      checkpoint_id: state.checkpointId,
      expected_commit: altered ? state.head : state.commit,
    }),
    effect: async (context, state: { workspaceId: string }) => 1 - (await checkpoints(context, state.workspaceId)),
  },
  {
    // Each restore first saves a safety checkpoint, so the checkpoint count counts executions.
    op: 'checkpoint.restore',
    outcome: settledReply,
    unknown: () => false,
    setup: async (context) => {
      await context.repo.dirty('README.md', 'checkpointed\n')
      const workspaceId = await workspace(context)
      const { checkpoint } = await context.profile.call('checkpoint.create', {
        operation_id: 'setup-checkpoint',
        workspace_id: workspaceId,
      })
      await context.repo.dirty('README.md', 'edited after the checkpoint\n')
      const preview = await context.profile.call('checkpoint.restore.preview', {
        workspace_id: workspaceId,
        checkpoint_id: checkpoint.checkpoint_id,
      })
      return { workspaceId, checkpointId: checkpoint.checkpoint_id, state: preview.state_token }
    },
    request: (state: { workspaceId: string; checkpointId: string; state: string }, id, altered) => ({
      workspace_id: state.workspaceId,
      operation_id: id,
      checkpoint_id: state.checkpointId,
      expected_state: state.state,
      confirm_overwrite: !altered,
    }),
    effect: async (context, state: { workspaceId: string }) => (await checkpoints(context, state.workspaceId)) - 1,
  },
  {
    op: 'skill.install',
    outcome: settledReply,
    unknown: () => false,
    setup: async (context) => {
      const source = join(context.ade.root, 'skills', 'reliability-skill')
      const other = join(context.ade.root, 'skills', 'other-skill')
      await writeSkill(source, 'reliability-skill')
      await writeSkill(other, 'other-skill')
      return { source, other }
    },
    request: (state: { source: string; other: string }, id, altered) => ({
      operation_id: id,
      source_path: altered ? state.other : state.source,
    }),
    effect: async (context) =>
      (await call(context.profile, 'skill.list', {})).skills.filter(
        (skill: { name: string }) => skill.name === 'reliability-skill',
      ).length,
  },
  {
    op: 'repository.clone',
    outcome: settledReply,
    unknown: () => false,
    setup: async (context) => {
      const remote = join(context.ade.root, 'remotes', 'origin.git')
      await mkdir(dirname(remote), { recursive: true })
      await context.repo.git('clone', '--quiet', '--bare', context.repo.path, remote)
      await mkdir(join(context.ade.root, 'clones'), { recursive: true })
      return {
        url: pathToFileURL(remote).href,
        destination: join(context.ade.root, 'clones', 'reliability'),
        other: join(context.ade.root, 'clones', 'other'),
      }
    },
    request: (state: { url: string; destination: string; other: string }, id, altered) => ({
      operation_id: id,
      url: state.url,
      destination: altered ? state.other : state.destination,
    }),
    effect: async (_context, state: { destination: string }) => Number(await exists(state.destination)),
  },
]
