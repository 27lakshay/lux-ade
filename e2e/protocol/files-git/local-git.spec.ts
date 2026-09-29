// F075, local half: stage, unstage, discard and commit with receipts; branch,
// stash and merge; conflicts and changed working-state preconditions; retries,
// changed payloads and a daemon crash mid-operation.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { git, openWorkspace, operationId, settled, status } from './steps'

test('stage, unstage, discard and commit each return a receipt, replay it for the same ID and refuse a changed payload', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' } })
  const workspace_id = await openWorkspace(profile, repo.path)
  await repo.write('a.txt', 'a2\n')
  await repo.write('b.txt', 'b2\n')
  await repo.write('new.txt', 'new\n')

  let state = await status(profile, workspace_id)
  expect(state).toMatchObject({ root: repo.path, branch: 'main', head: await repo.head(), conflicts: 0 })
  expect(
    Object.fromEntries(state.files.map((file) => [file.path, [file.staged, file.unstaged, file.untracked]])),
  ).toEqual({ 'a.txt': [false, true, false], 'b.txt': [false, true, false], 'new.txt': [false, true, true] })

  // Stage: the receipt settles, and the same ID replays it without running again.
  const stageId = operationId('stage')
  const staged = await git(profile, 'review.stage', {
    workspace_id,
    operation_id: stageId,
    path: 'a.txt',
    revision: state.revision,
  })
  expect(staged).toMatchObject({
    id: stageId,
    op: 'review.stage',
    status: 'succeeded',
    result: { changed: 'a.txt', action: 'review.stage' },
  })
  expect(await repo.status()).toContain('M  a.txt')
  const replay = await profile.call('review.stage', {
    workspace_id,
    operation_id: stageId,
    path: 'a.txt',
    revision: state.revision,
  })
  expect(replay.operation).toEqual(staged)
  await expect(
    profile.call('review.stage', { workspace_id, operation_id: stageId, path: 'b.txt', revision: state.revision }),
  ).rejects.toThrow(/different parameters/)

  // The old revision is stale now; the mutation fails and changes nothing.
  const stale = await git(profile, 'review.stage', { workspace_id, path: 'b.txt', revision: state.revision })
  expect(stale).toMatchObject({ status: 'failed', error: expect.stringMatching(/Changes moved since review/) })
  expect(await repo.status()).toContain(' M b.txt')

  // Untracked files stage too; unstage returns them to untracked.
  state = await status(profile, workspace_id)
  expect(await git(profile, 'review.stage', { workspace_id, path: 'new.txt', revision: state.revision })).toMatchObject(
    { status: 'succeeded' },
  )
  state = await status(profile, workspace_id)
  expect(
    await git(profile, 'review.unstage', { workspace_id, path: 'new.txt', revision: state.revision }),
  ).toMatchObject({ status: 'succeeded' })
  expect(await repo.status()).toContain('?? new.txt')

  // Discard needs the previewed diff token; a later edit makes it stale and keeps the new bytes.
  state = await status(profile, workspace_id)
  const preview = await profile.call('review.diff', { workspace_id, path: 'b.txt', staged: false })
  await repo.write('b.txt', 'b3 newer edit\n')
  const refused = await git(profile, 'review.discard', {
    workspace_id,
    path: 'b.txt',
    revision: state.revision,
    diff_token: preview.token,
  })
  expect(refused).toMatchObject({ status: 'failed', error: expect.stringMatching(/preview|moved|changed/i) })
  expect(await repo.read('b.txt')).toBe('b3 newer edit\n')
  state = await status(profile, workspace_id)
  const fresh = await profile.call('review.diff', { workspace_id, path: 'b.txt', staged: false })
  const discarded = await git(profile, 'review.discard', {
    workspace_id,
    path: 'b.txt',
    revision: state.revision,
    diff_token: fresh.token,
  })
  expect(discarded).toMatchObject({ status: 'succeeded', result: { changed: 'b.txt', action: 'review.discard' } })
  expect(await repo.read('b.txt')).toBe('b1\n')
  expect(await readFile(discarded.backup_path!, 'utf8')).toBe('b3 newer edit\n')
  // Untracked files are not discarded.
  state = await status(profile, workspace_id)
  const untracked = await git(profile, 'review.discard', {
    workspace_id,
    path: 'new.txt',
    revision: state.revision,
    diff_token: fresh.token,
  })
  expect(untracked).toMatchObject({ status: 'failed' })
  expect(existsSync(join(repo.path, 'new.txt'))).toBe(true)

  // Commit through the CLI with the reviewed index token.
  state = await status(profile, workspace_id)
  const before = await repo.head()
  const commitId = operationId('commit')
  const cli = await profile.cli(
    'git',
    'commit',
    workspace_id,
    'Update a',
    state.index_token,
    '--operation-id',
    commitId,
  )
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ operation_id: commitId, workspace_id })
  const committed = await settled(profile, workspace_id, commitId)
  expect(committed).toMatchObject({ status: 'succeeded', result: { head: await repo.head() } })
  expect(await repo.git('rev-parse', 'HEAD^')).toBe(before)
  expect(await repo.git('log', '-1', '--format=%s')).toBe('Update a')
  expect(await repo.git('show', '--name-only', '--format=', 'HEAD')).toBe('a.txt')
  // A retry of the commit never commits twice; the old index token is stale.
  const again = await profile.cli(
    'git',
    'commit',
    workspace_id,
    'Update a',
    state.index_token,
    '--operation-id',
    commitId,
  )
  expect(again.code).toBe(0)
  expect((again.json!.operation as { status: string }).status).toBe('succeeded')
  expect(await repo.git('rev-list', '--count', 'HEAD')).toBe('2')
  await repo.write('c.txt', 'c2\n')
  await repo.git('add', 'c.txt')
  const staleCommit = await git(profile, 'review.commit', {
    workspace_id,
    message: 'Stale',
    index_token: state.index_token,
  })
  expect(staleCommit).toMatchObject({ status: 'failed', error: expect.stringMatching(/Review them again/) })
  expect(await repo.git('rev-list', '--count', 'HEAD')).toBe('2')

  // The CLI reads the receipt back, and no operation is left running.
  const read = await profile.cli('git', 'operation', workspace_id, commitId)
  expect(read.json).toMatchObject({ operation: { id: commitId, status: 'succeeded' } })
  expect((await profile.call('review.operation.list', { workspace_id })).operations).toEqual([])
})

test('branches, stashes and merges through explicit commands, showing conflicts until they are resolved or aborted', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: { 'shared.txt': 'base\n', 'other.txt': 'o\n' } })
  const workspace_id = await openWorkspace(profile, repo.path)
  const base = await repo.head()
  const token = async () => (await status(profile, workspace_id)).index_token

  // Create and switch in one step, through the CLI.
  const createId = operationId('branch')
  const created = await profile.cli(
    'git',
    'branch',
    workspace_id,
    'feature',
    await token(),
    '--operation-id',
    createId,
    '--create',
    '--switch',
  )
  expect(created.code).toBe(0)
  expect(await settled(profile, workspace_id, createId)).toMatchObject({
    status: 'succeeded',
    result: { action: 'branch', name: 'feature', created: true, branch: 'feature', head: base },
  })
  expect(await repo.git('branch', '--show-current')).toBe('feature')
  await repo.commit('Feature edit', { 'shared.txt': 'feature\n' })

  // Refusals: an existing branch, an invalid name, a missing branch, no action.
  for (const [request, error] of [
    [{ name: 'feature', create: true }, /already exists/],
    [{ name: 'bad..name', create: true }, /Invalid branch name/],
    [{ name: '-x', switch: true }, /Invalid branch name/],
    [{ name: 'missing', switch: true }, /does not exist/],
    [{ name: 'main' }, /create, switch or both/],
  ] as const) {
    expect(await git(profile, 'review.branch', { workspace_id, index_token: await token(), ...request })).toMatchObject(
      { status: 'failed', error: expect.stringMatching(error) },
    )
  }
  expect(await repo.git('branch', '--format=%(refname:short)')).toBe('feature\nmain')

  // Git refuses a switch that would overwrite a local change; the change survives.
  await repo.write('shared.txt', 'uncommitted on feature\n')
  const blocked = await git(profile, 'review.branch', {
    workspace_id,
    name: 'main',
    switch: true,
    index_token: await token(),
  })
  expect(blocked).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/git switch failed: .*local changes/),
  })
  expect(await repo.read('shared.txt')).toBe('uncommitted on feature\n')

  // Stash the change with an untracked file, switch, and bring it back.
  await repo.write('scratch.txt', 'untracked\n')
  let state = await status(profile, workspace_id)
  const pushed = await git(profile, 'review.stash', {
    workspace_id,
    action: 'push',
    revision: state.revision,
    include_untracked: true,
    message: 'wip on feature',
  })
  expect(pushed).toMatchObject({
    status: 'succeeded',
    result: { action: 'stash_push', stash: expect.any(String), branch: 'feature' },
  })
  expect(await repo.status()).toEqual([])
  expect(await repo.git('stash', 'list', '--format=%s')).toContain('wip on feature')
  state = await status(profile, workspace_id)
  expect(await git(profile, 'review.stash', { workspace_id, action: 'push', revision: state.revision })).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/no changes to stash/),
  })
  expect(
    await git(profile, 'review.branch', { workspace_id, name: 'main', switch: true, index_token: await token() }),
  ).toMatchObject({ status: 'succeeded', result: { branch: 'main', head: base } })
  expect(
    await git(profile, 'review.branch', { workspace_id, name: 'feature', switch: true, index_token: await token() }),
  ).toMatchObject({ status: 'succeeded', result: { branch: 'feature' } })
  state = await status(profile, workspace_id)
  const popped = await git(profile, 'review.stash', { workspace_id, action: 'pop', revision: state.revision })
  expect(popped).toMatchObject({ status: 'succeeded', result: { action: 'stash_pop', stash: pushed.result!.stash } })
  expect(await repo.read('shared.txt')).toBe('uncommitted on feature\n')
  expect(await repo.read('scratch.txt')).toBe('untracked\n')
  expect(await repo.git('stash', 'list')).toBe('')
  // A stash taken against a stale revision is refused and nothing moves.
  await repo.write('other.txt', 'o changed after review\n')
  const staleStash = await git(profile, 'review.stash', { workspace_id, action: 'push', revision: state.revision })
  expect(staleStash).toMatchObject({ status: 'failed', error: expect.stringMatching(/Changes moved/) })
  expect(await repo.read('other.txt')).toBe('o changed after review\n')
  await repo.git('checkout', '--', 'shared.txt', 'other.txt')
  await repo.git('clean', '-fq')

  // Merge main's conflicting change into feature: the receipt lists the conflict.
  await repo.git('switch', '--quiet', 'main')
  const mainHead = await repo.commit('Main edit', { 'shared.txt': 'main\n' })
  await repo.git('switch', '--quiet', 'feature')
  const featureHead = await repo.head()
  const mergeId = operationId('merge')
  const merge = await profile.cli('git', 'merge', workspace_id, 'main', await token(), '--operation-id', mergeId)
  expect(merge.code).toBe(0)
  const stopped = await settled(profile, workspace_id, mergeId)
  expect(stopped).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/conflicts in 1 file/),
    result: { action: 'merge', target: 'main', target_commit: mainHead, conflicts: ['shared.txt'] },
  })
  state = await status(profile, workspace_id)
  expect(state.conflicts).toBe(1)
  expect(state.files.find((file) => file.path === 'shared.txt')).toMatchObject({ conflict: true, code: 'UU' })
  // Conflicts block commit, stash and another merge.
  expect(
    await git(profile, 'review.commit', { workspace_id, message: 'Too early', index_token: state.index_token }),
  ).toMatchObject({ status: 'failed', error: expect.stringMatching(/Resolve and stage conflicting files/) })
  expect(await git(profile, 'review.stash', { workspace_id, action: 'push', revision: state.revision })).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/Resolve conflicting files/),
  })
  expect(
    await git(profile, 'review.merge', {
      workspace_id,
      action: 'merge',
      target: 'main',
      index_token: state.index_token,
    }),
  ).toMatchObject({ status: 'failed', error: expect.stringMatching(/already in progress/) })

  // Abort restores the pre-merge state.
  const aborted = await profile.cli(
    'git',
    'merge-abort',
    workspace_id,
    state.index_token,
    '--operation-id',
    operationId('abort'),
  )
  expect(aborted.code).toBe(0)
  await expect.poll(async () => (await repo.status()).length).toBe(0)
  expect(await repo.head()).toBe(featureHead)
  expect(await repo.read('shared.txt')).toBe('feature\n')
  expect(
    await git(profile, 'review.merge', { workspace_id, action: 'abort', index_token: await token() }),
  ).toMatchObject({ status: 'failed', error: expect.stringMatching(/No merge is in progress/) })

  // Merge again, resolve, stage and commit: a two-parent merge commit.
  expect(
    await git(profile, 'review.merge', { workspace_id, action: 'merge', target: 'main', index_token: await token() }),
  ).toMatchObject({ status: 'failed', result: { conflicts: ['shared.txt'] } })
  await repo.write('shared.txt', 'feature and main\n')
  state = await status(profile, workspace_id)
  expect(
    await git(profile, 'review.stage', { workspace_id, path: 'shared.txt', revision: state.revision }),
  ).toMatchObject({ status: 'succeeded' })
  state = await status(profile, workspace_id)
  expect(state.conflicts).toBe(0)
  const resolved = await git(profile, 'review.commit', {
    workspace_id,
    message: 'Merge main into feature',
    index_token: state.index_token,
  })
  expect(resolved).toMatchObject({ status: 'succeeded' })
  expect((await repo.git('log', '-1', '--format=%P')).split(' ')).toEqual([featureHead, mainHead])

  // A clean merge, and a stale token or unknown target refused before Git runs.
  await repo.git('switch', '--quiet', 'main')
  const staleToken = await token()
  await repo.commit('Main again', { 'other.txt': 'o2\n' })
  expect(
    await git(profile, 'review.merge', { workspace_id, action: 'merge', target: 'feature', index_token: staleToken }),
  ).toMatchObject({ status: 'failed', error: expect.stringMatching(/moved since review/) })
  expect(
    await git(profile, 'review.merge', {
      workspace_id,
      action: 'merge',
      target: 'no-such-branch',
      index_token: await token(),
    }),
  ).toMatchObject({ status: 'failed', error: expect.stringMatching(/Unknown merge target/) })
  expect(
    await git(profile, 'review.merge', {
      workspace_id,
      action: 'merge',
      target: '--no-verify',
      index_token: await token(),
    }),
  ).toMatchObject({ status: 'failed', error: expect.stringMatching(/Invalid merge target/) })
  const clean = await git(profile, 'review.merge', {
    workspace_id,
    action: 'merge',
    target: 'feature',
    index_token: await token(),
  })
  expect(clean).toMatchObject({ status: 'succeeded', result: { action: 'merge', target: 'feature', branch: 'main' } })
  expect(await repo.read('shared.txt')).toBe('feature and main\n')
  expect(await repo.read('other.txt')).toBe('o2\n')
})

test('a stash pop that conflicts keeps the stash and reports the conflicting files', async ({ ade, profile }) => {
  const repo = await ade.repo({ initialFiles: { 'x.txt': 'one\n' } })
  const workspace_id = await openWorkspace(profile, repo.path)
  await repo.write('x.txt', 'stashed\n')
  let state = await status(profile, workspace_id)
  expect(await git(profile, 'review.stash', { workspace_id, action: 'push', revision: state.revision })).toMatchObject({
    status: 'succeeded',
  })
  await repo.commit('Conflicting commit', { 'x.txt': 'committed\n' })
  state = await status(profile, workspace_id)
  const pop = await git(profile, 'review.stash', { workspace_id, action: 'pop', revision: state.revision })
  expect(pop).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/conflicts in 1 file.*stash was kept/),
    result: { action: 'stash_pop', conflicts: ['x.txt'] },
  })
  expect(await repo.git('stash', 'list', '--format=%gd')).toBe('stash@{0}')
  expect((await status(profile, workspace_id)).conflicts).toBe(1)
  // Nothing to pop is its own refusal.
  await repo.git('checkout', '--quiet', 'HEAD', '--', 'x.txt')
  await repo.git('stash', 'drop', '--quiet')
  state = await status(profile, workspace_id)
  expect(await git(profile, 'review.stash', { workspace_id, action: 'pop', revision: state.revision })).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/no stash to pop/),
  })
})

test('a daemon killed during a Git mutation leaves an interrupted receipt that is never run again', async ({ ade }) => {
  const pause = join(ade.root, 'review-pause')
  await mkdir(pause, { recursive: true })
  const profile = await ade.profile({ env: { ADE_E2E_WORKER_PAUSE_ENABLED: '1', ADE_E2E_REVIEW_PAUSE_DIR: pause } })
  const repo = await ade.repo({ initialFiles: { 'a.txt': 'a\n' } })
  const workspace_id = await openWorkspace(profile, repo.path)
  await repo.write('a.txt', 'staged\n')
  await repo.git('add', 'a.txt')
  const state = await status(profile, workspace_id)
  const head = await repo.head()

  await writeFile(join(pause, 'armed'), '')
  const id = operationId('commit')
  const admitted = await profile.call('review.commit', {
    workspace_id,
    operation_id: id,
    message: 'Never twice',
    index_token: state.index_token,
  })
  expect(admitted.operation.status).toBe('running')
  await expect.poll(() => existsSync(join(pause, 'signal')), { timeout: 15_000 }).toBe(true)
  expect(
    (await profile.call('review.operation.list', { workspace_id })).operations.map((entry) => entry.operation.id),
  ).toEqual([id])
  await profile.killDaemon()
  await rm(join(pause, 'armed'))
  await writeFile(join(pause, 'release'), '')
  await profile.restartDaemon()

  // The worker's lock is released once the paused Git step exits.
  await expect
    .poll(
      async () =>
        await status(profile, workspace_id).then(
          () => 'ok',
          (error) => String(error),
        ),
      { timeout: 15_000 },
    )
    .toBe('ok')
  const receipt = (await profile.call('review.operation', { workspace_id, operation_id: id })).operation
  expect(receipt).toMatchObject({ id, status: 'interrupted', error: expect.stringMatching(/will not run again/) })
  const retry = await profile.call('review.commit', {
    workspace_id,
    operation_id: id,
    message: 'Never twice',
    index_token: state.index_token,
  })
  expect(retry.operation.status).toBe('interrupted')
  expect(await repo.head()).toBe(head)
  expect(await repo.status()).toEqual(['M  a.txt'])

  const listed = await profile.cli('git', 'operations', workspace_id)
  expect(listed.json).toMatchObject({
    operations: [{ operation: { id, status: 'interrupted' }, acknowledged_at: null }],
  })
  const ack = await profile.call('review.operation.acknowledge', { workspace_id, operation_id: id })
  expect(ack.acknowledged_at).toEqual(expect.any(Number))
  expect((await profile.call('review.operation.list', { workspace_id })).operations).toEqual([])
  expect(
    (await profile.call('review.operation.list', { workspace_id, include_acknowledged: true })).operations.map(
      (entry) => entry.operation.id,
    ),
  ).toEqual([id])

  // A fresh ID commits the reviewed index exactly once.
  const fresh = await git(profile, 'review.commit', {
    workspace_id,
    message: 'Committed once',
    index_token: (await status(profile, workspace_id)).index_token,
  })
  expect(fresh).toMatchObject({ status: 'succeeded' })
  expect(await repo.git('rev-list', '--count', 'HEAD')).toBe('2')
  // Receipts survive a graceful restart as well.
  await profile.restartDaemon()
  expect((await profile.call('review.operation', { workspace_id, operation_id: fresh.id })).operation).toEqual(fresh)
})
