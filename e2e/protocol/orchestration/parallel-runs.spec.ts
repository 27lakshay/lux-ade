// F105 and 09-S08: a parallel run group starts one task as sibling children
// with explicit providers, accounts and workspaces; comparing it reads each
// run's outcome and Git changes and merges nothing.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, fixtureAnswers, prompts, test, type ScratchProfile } from '../fixtures'
import { createWorktree } from '../fixtures/worktrees'
import { opId, parentIn } from './steps'

/** The parts of a started group's CLI output this spec reads. */
type StartedGroup = {
  group: {
    group_id: string
    operation_id: string
    runs: Array<{
      index: number
      base_commit: string | null
      child: {
        child_conversation_id: string
        parent_conversation_id: string
        provider: string
        workspace_id: string
        workspace_mode: string
        account_id: string | null
      }
    }>
  }
}

async function waitForGroup(profile: ScratchProfile, groupId: string, state: string, timeout = 20_000) {
  await expect
    .poll(async () => (await profile.call('orchestration.group.get', { group_id: groupId })).group.summary.state, {
      timeout,
    })
    .toBe(state)
  return (await profile.call('orchestration.group.get', { group_id: groupId })).group
}

test('starts runs on two providers in new worktrees and compares their outcomes, changes and overlaps without merging', async ({
  profile,
  repo,
}) => {
  const { parent } = await parentIn(profile, repo.path)
  const operation = opId('runs')
  // The CLI default: one new worktree per run in the parent's repository.
  const started = await profile.cli(
    'runs',
    'start',
    parent,
    prompts.turn,
    '--run',
    'codex:inherit',
    '--run',
    'claude:ambient',
    '--operation-id',
    operation,
  )
  expect(started.code).toBe(0)
  const { group } = started.json as unknown as StartedGroup
  expect(group.operation_id).toBe(operation)
  expect(group.runs.map((run) => [run.index, run.child.provider, run.child.workspace_mode])).toEqual([
    [0, 'codex', 'new_worktree'],
    [1, 'claude', 'new_worktree'],
  ])
  expect(group.runs.every((run) => run.child.parent_conversation_id === parent)).toBe(true)
  expect(group.runs[1].child.account_id).toBeNull()
  expect(group.runs[0].child.workspace_id).not.toBe(group.runs[1].child.workspace_id)
  const base = await repo.head()
  expect(group.runs.map((run) => run.base_commit)).toEqual([base, base])

  const done = await waitForGroup(profile, group.group_id, 'completed')
  expect(done.summary).toMatchObject({ runs: 2, completed: 2, pending: 0 })

  // Each run edits its own worktree: both touch shared.txt, run 0 commits its edit.
  const { catalog } = await profile.call('catalog.get', {})
  const roots = group.runs.map((run) => catalog.workspaces.find((item) => item.id === run.child.workspace_id)!.root)
  await writeFile(join(roots[0], 'shared.txt'), 'from run 0\n')
  await repo.git('-C', roots[0], 'add', 'shared.txt')
  await repo.git('-C', roots[0], 'commit', '--quiet', '-m', 'Run 0 edit')
  await writeFile(join(roots[0], 'only-zero.txt'), 'zero\n')
  await writeFile(join(roots[1], 'shared.txt'), 'from run 1\n')

  const comparison = await profile.call('orchestration.group.compare', { group_id: group.group_id })
  expect(comparison.summary.state).toBe('completed')
  expect(comparison.overlaps).toEqual([{ path: 'shared.txt', runs: [0, 1] }])
  const [zero, one] = comparison.runs as unknown as Array<{
    shared_workspace: boolean
    progress: { state: string; outcome?: string }
    changes: {
      state: string
      uncommitted: Array<{ path: string }>
      committed: { state: string; commits?: number; files?: Array<{ path: string; code: string }> }
    }
  }>
  expect(zero).toMatchObject({ shared_workspace: false, progress: { state: 'settled', outcome: 'completed' } })
  expect(one).toMatchObject({ shared_workspace: false, progress: { state: 'settled', outcome: 'completed' } })
  expect(zero.changes.committed).toMatchObject({
    state: 'known',
    commits: 1,
    files: [{ path: 'shared.txt', code: 'A' }],
  })
  expect(zero.changes.uncommitted.map((file) => file.path)).toEqual(['only-zero.txt'])
  expect(one.changes.committed).toMatchObject({ state: 'known', commits: 0, files: [] })
  expect(one.changes.uncommitted.map((file) => file.path)).toEqual(['shared.txt'])

  // Nothing was merged, staged or moved: the parent checkout and both worktrees are as the runs left them.
  expect(await repo.head()).toBe(base)
  expect(await repo.status()).toEqual([])
  expect(await repo.git('-C', roots[1], 'status', '--porcelain=v1')).toBe('?? shared.txt')
  expect(await repo.git('-C', roots[0], 'show', 'HEAD:shared.txt')).toBe('from run 0')
  const again = await profile.cli('runs', 'compare', group.group_id)
  expect(again.code).toBe(0)
  expect(again.json).toMatchObject({ type: 'group_comparison', overlaps: [{ path: 'shared.txt', runs: [0, 1] }] })

  const listed = await profile.cli('runs', 'list', parent)
  expect((listed.json as { groups: Array<{ group_id: string }> }).groups.map((item) => item.group_id)).toEqual([
    group.group_id,
  ])
  expect((await profile.cli('runs', 'get', group.group_id)).json).toMatchObject({
    type: 'group',
    group: { group_id: group.group_id },
  })
  // A retry of the CLI start with the same operation ID resumes the same worktrees and returns the same group.
  const retried = await profile.cli(
    'runs',
    'start',
    parent,
    prompts.turn,
    '--run',
    'codex:inherit',
    '--run',
    'claude:ambient',
    '--operation-id',
    operation,
  )
  expect((retried.json as unknown as StartedGroup).group.group_id).toBe(group.group_id)
})

test('runs that share the parent workspace are marked shared, and their changes are not attributed per run', async ({
  profile,
  repo,
}) => {
  const { parent } = await parentIn(profile, repo.path)
  const { group } = await profile.call('orchestration.group.start', {
    operation_id: opId('same'),
    parent_conversation_id: parent,
    caller: { kind: 'agent', conversation_id: parent },
    task: prompts.turn,
    runs: [
      { provider: 'codex', account: { mode: 'inherit' }, workspace: { mode: 'same' } },
      { provider: 'claude', account: { mode: 'ambient' }, workspace: { mode: 'same' } },
    ],
  })
  expect(group.attribution).toBe(`agent:${parent}`)
  await waitForGroup(profile, group.group_id, 'completed')
  await repo.dirty('README.md', '# Edited by someone in the shared workspace\n')

  const comparison = await profile.call('orchestration.group.compare', { group_id: group.group_id })
  const runs = comparison.runs as unknown as Array<{
    shared_workspace: boolean
    changes: { uncommitted: Array<{ path: string }> }
  }>
  expect(runs.map((run) => run.shared_workspace)).toEqual([true, true])
  expect(runs.map((run) => run.changes.uncommitted.map((file) => file.path))).toEqual([['README.md'], ['README.md']])
  // Overlaps count workspaces, not runs: one workspace cannot overlap with itself.
  expect(comparison.overlaps).toEqual([])
})

test('a repeated group operation ID deduplicates, a changed payload conflicts, and invalid groups leave nothing behind (09-S08)', async ({
  profile,
  repo,
}) => {
  const { parent } = await parentIn(profile, repo.path)
  const tree = await createWorktree(profile, repo.path, 'shared-run-tree')
  const runs = [
    { provider: 'codex', account: { mode: 'inherit' as const }, workspace: { mode: 'same' as const } },
    { provider: 'codex', account: { mode: 'ambient' as const }, workspace: { mode: 'same' as const } },
  ]
  const request = {
    operation_id: opId('group'),
    parent_conversation_id: parent,
    caller: { kind: 'user' as const },
    task: prompts.turn,
    runs,
  }

  const invalid = [
    { ...request, operation_id: opId('one-run'), runs: runs.slice(0, 1) },
    { ...request, operation_id: opId('cross'), runs: [runs[0], { ...runs[0], provider: 'claude' }] },
    {
      ...request,
      operation_id: opId('same-tree'),
      runs: [0, 1].map(() => ({
        provider: 'codex',
        account: { mode: 'ambient' as const },
        workspace: {
          mode: 'new_worktree' as const,
          workspace_id: tree.workspaceId,
          repository_id: tree.repositoryId,
          worktree_operation_id: tree.operationId,
        },
      })),
    },
  ]
  for (const bad of invalid) await expect(profile.call('orchestration.group.start', bad)).rejects.toThrow()
  expect((await profile.call('orchestration.groups', { parent_conversation_id: parent })).groups).toEqual([])
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toEqual([])

  const first = await profile.call('orchestration.group.start', request)
  const replay = await profile.call('orchestration.group.start', request)
  expect(replay.group.group_id).toBe(first.group.group_id)
  expect(replay.group.runs.map((run) => run.child.child_conversation_id)).toEqual(
    first.group.runs.map((run) => run.child.child_conversation_id),
  )
  await expect(profile.call('orchestration.group.start', { ...request, task: 'a different task' })).rejects.toThrow(
    /already used for a different parallel group/,
  )
  expect((await profile.call('orchestration.children', { parent_conversation_id: parent })).children).toHaveLength(2)

  // After a daemon crash the group, its runs and its receipt remain.
  await waitForGroup(profile, first.group.group_id, 'completed')
  await profile.restartDaemon('kill')
  const { groups } = await profile.call('orchestration.groups', { parent_conversation_id: parent })
  expect(groups.map((group) => group.group_id)).toEqual([first.group.group_id])
  expect(groups[0].runs).toHaveLength(2)
  expect((await profile.call('orchestration.group.start', request)).group.group_id).toBe(first.group.group_id)
})

test('the group reports attention for a question, and ended rather than completed when a run is interrupted', async ({
  profile,
}) => {
  const { parent } = await parentIn(profile, profile.defaultWorkspaceRoot)
  const runs = [
    { provider: 'codex', account: { mode: 'inherit' as const }, workspace: { mode: 'same' as const } },
    { provider: 'claude', account: { mode: 'ambient' as const }, workspace: { mode: 'same' as const } },
  ]
  const asked = await profile.call('orchestration.group.start', {
    operation_id: opId('ask'),
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    task: prompts.questions,
    runs,
  })
  const attention = await waitForGroup(profile, asked.group.group_id, 'needs_attention')
  expect(attention.summary.needs_input).toBeGreaterThanOrEqual(1)
  for (const run of asked.group.runs) {
    const childId = run.child.child_conversation_id
    let request: { id: string; method: string; params: Record<string, unknown> } | undefined
    await expect
      .poll(async () => {
        request = (await profile.call('conversation.get', { conversation_id: childId })).requests[0] as typeof request
        return request !== undefined
      })
      .toBe(true)
    await profile.call('agent.answer', {
      conversation_id: childId,
      request_id: request!.id,
      decision: 'answer',
      answers: fixtureAnswers(request!),
    })
  }
  await waitForGroup(profile, asked.group.group_id, 'completed')

  const held = await profile.call('orchestration.group.start', {
    operation_id: opId('hold'),
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    task: prompts.hold,
    runs,
  })
  await waitForGroup(profile, held.group.group_id, 'running')
  for (const run of held.group.runs) {
    const childId = run.child.child_conversation_id
    await expect
      .poll(async () => (await profile.call('conversation.get', { conversation_id: childId })).conversation.status)
      .toBe('running')
    await profile.call('agent.cancel', { conversation_id: childId })
  }
  const ended = await waitForGroup(profile, held.group.group_id, 'ended')
  expect(ended.summary).toMatchObject({ runs: 2, completed: 0, interrupted: 2 })
})
