// F075, remote half: fetch, pull and push against local bare remotes, with
// rejected pushes, diverged pulls, missing upstreams, duplicate requests and a
// daemon killed while a push is in flight.
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ScratchRepo } from '../fixtures'
import { bareRemote, remoteHead } from '../fixtures/git-remotes'
import { git, openWorkspace, operationId, settled, status } from './steps'

/** A clone of `bare` that stands for a teammate pushing from elsewhere. */
async function teammate(repo: ScratchRepo, bare: string, path: string) {
  await repo.git('clone', '--quiet', bare, path)
  const at = (...args: string[]) => repo.git('-C', path, ...args)
  await at('config', 'user.name', 'Teammate')
  await at('config', 'user.email', 'teammate@example.invalid')
  return {
    async push(file: string, content: string, message: string): Promise<string> {
      await at('pull', '--quiet', '--ff-only')
      await writeFile(join(path, file), content)
      await at('add', file)
      await at('commit', '--quiet', '-m', message)
      await at('push', '--quiet', 'origin', 'HEAD:main')
      return at('rev-parse', 'HEAD')
    },
  }
}

test('fetch, pull and push move commits between the workspace and a bare remote without force', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: { 'app.txt': 'v1\n' } })
  const bare = await bareRemote(repo, join(ade.root, 'remotes', 'origin.git'), {})
  await repo.git('remote', 'add', 'origin', `file://${bare}`)
  await repo.git('fetch', '--quiet', 'origin')
  await repo.git('branch', '--quiet', '--set-upstream-to=origin/main', 'main')
  const mate = await teammate(repo, bare, join(ade.root, 'teammate'))
  const workspace_id = await openWorkspace(profile, repo.path)
  const token = async () => (await status(profile, workspace_id)).index_token

  // Fetch changes only remote-tracking refs.
  const upstreamHead = await mate.push('mate.txt', 'from teammate\n', 'Teammate change')
  const localHead = await repo.head()
  const fetchId = operationId('fetch')
  const fetched = await profile.cli('git', 'fetch', workspace_id, '--operation-id', fetchId)
  expect(fetched.code).toBe(0)
  expect(await settled(profile, workspace_id, fetchId)).toMatchObject({
    status: 'succeeded',
    result: { action: 'fetch', remote: 'origin', updated: ['refs/remotes/origin/main'], head: localHead },
  })
  expect(await repo.git('rev-parse', 'origin/main')).toBe(upstreamHead)
  expect(await repo.head()).toBe(localHead)
  expect(existsSync(join(repo.path, 'mate.txt'))).toBe(false)
  // Fetching again reports no updated refs.
  expect(await git(profile, 'review.fetch', { workspace_id, remote: 'origin' })).toMatchObject({
    status: 'succeeded',
    result: { updated: [] },
  })

  // Pull fast-forwards to the upstream.
  const pullId = operationId('pull')
  const pulled = await profile.cli('git', 'pull', workspace_id, await token(), '--operation-id', pullId)
  expect(pulled.code).toBe(0)
  expect(await settled(profile, workspace_id, pullId)).toMatchObject({
    status: 'succeeded',
    result: {
      action: 'pull',
      branch: 'main',
      upstream: 'origin/main',
      before: localHead,
      head: upstreamHead,
      fast_forward: true,
    },
  })
  expect(await repo.read('mate.txt')).toBe('from teammate\n')

  // Commit through ADE and push; the remote is read back at the pushed commit.
  await repo.write('app.txt', 'v2\n')
  let state = await status(profile, workspace_id)
  await git(profile, 'review.stage', { workspace_id, path: 'app.txt', revision: state.revision })
  const commit = await git(profile, 'review.commit', { workspace_id, message: 'App v2', index_token: await token() })
  const pushId = operationId('push')
  const pushedCli = await profile.cli('git', 'push', workspace_id, await token(), '--operation-id', pushId)
  expect(pushedCli.code).toBe(0)
  const pushed = await settled(profile, workspace_id, pushId)
  expect(pushed).toMatchObject({
    status: 'succeeded',
    result: {
      action: 'push',
      branch: 'main',
      remote: 'origin',
      remote_ref: 'refs/heads/main',
      head: commit.result!.head,
      verified: true,
      upstream_set: false,
    },
  })
  expect(await remoteHead(repo, bare)).toBe(commit.result!.head)
  // The same ID replays the receipt; a changed payload under it is refused.
  const replay = await profile.call('review.push', {
    workspace_id,
    operation_id: pushId,
    index_token: (await status(profile, workspace_id)).index_token,
  })
  expect(replay.operation.status).toBe('succeeded')
  expect(replay.operation.id).toBe(pushId)
  await expect(
    profile.call('review.push', { workspace_id, operation_id: pushId, index_token: 'changed', remote: 'origin' }),
  ).rejects.toThrow(/different parameters/)

  // A push that would drop the teammate's new commit is rejected, not forced.
  const theirs = await mate.push('mate.txt', 'teammate again\n', 'Teammate again')
  await repo.write('app.txt', 'v3\n')
  await repo.git('commit', '--quiet', '-am', 'App v3')
  const ours = await repo.head()
  const rejected = await git(profile, 'review.push', { workspace_id, index_token: await token() })
  expect(rejected).toMatchObject({ status: 'failed', error: expect.stringMatching(/git push failed: .*rejected/) })
  expect(await remoteHead(repo, bare)).toBe(theirs)

  // Pull refuses to merge a diverged branch; nothing local changes.
  expect(await git(profile, 'review.fetch', { workspace_id })).toMatchObject({ status: 'succeeded' })
  const diverged = await git(profile, 'review.pull', { workspace_id, index_token: await token() })
  expect(diverged).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/git pull failed: .*(fast-forward|diverg)/i),
  })
  expect(await repo.head()).toBe(ours)

  // Fetch, merge the upstream explicitly, then push the merge.
  const merged = await git(profile, 'review.merge', {
    workspace_id,
    action: 'merge',
    target: 'origin/main',
    index_token: await token(),
  })
  expect(merged).toMatchObject({
    status: 'succeeded',
    result: { target: 'origin/main', target_commit: theirs, before: ours },
  })
  expect(await git(profile, 'review.push', { workspace_id, index_token: await token() })).toMatchObject({
    status: 'succeeded',
    result: { verified: true },
  })
  expect(await remoteHead(repo, bare)).toBe(await repo.head())
  expect((await repo.git('log', '-1', '--format=%P')).split(' ')).toEqual([ours, theirs])

  // A push or pull reviewed against an older index is refused and changes nothing.
  const staleToken = await token()
  await repo.write('app.txt', 'v4 local only\n')
  await repo.git('add', 'app.txt')
  expect(await git(profile, 'review.push', { workspace_id, index_token: staleToken })).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/moved since review/),
  })
  expect(await git(profile, 'review.pull', { workspace_id, index_token: staleToken })).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/moved since review/),
  })
  expect(await repo.read('app.txt')).toBe('v4 local only\n')
})

test('a new branch needs a named remote once, names only configured remotes and reports unreachable remotes', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: { 'app.txt': 'v1\n' } })
  const bare = await bareRemote(repo, join(ade.root, 'remotes', 'origin.git'), {})
  const mirror = await bareRemote(repo, join(ade.root, 'remotes', 'mirror.git'), {})
  await repo.git('remote', 'add', 'origin', `file://${bare}`)
  await repo.git('remote', 'add', 'mirror', `file://${mirror}`)
  await repo.git('remote', 'add', 'gone', `file://${join(ade.root, 'remotes', 'missing.git')}`)
  const workspace_id = await openWorkspace(profile, repo.path)
  const token = async () => (await status(profile, workspace_id)).index_token

  await git(profile, 'review.branch', {
    workspace_id,
    name: 'topic',
    create: true,
    switch: true,
    index_token: await token(),
  })
  await repo.commit('Topic work', { 'topic.txt': 'topic\n' })
  expect(await git(profile, 'review.push', { workspace_id, index_token: await token() })).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/no upstream; choose a remote/),
  })
  expect(await git(profile, 'review.pull', { workspace_id, index_token: await token() })).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/no upstream/),
  })
  expect(await remoteHead(repo, bare, 'topic')).toBeNull()

  // Only configured remote names are accepted; a URL or an option is refused.
  for (const remote of [`file://${mirror}`, '--upload-pack=touch /tmp/x', 'nope']) {
    expect(
      await git(profile, 'review.push', { workspace_id, remote, index_token: await token() }),
      remote,
    ).toMatchObject({ status: 'failed', error: expect.stringMatching(/Unknown remote/) })
    expect(await git(profile, 'review.fetch', { workspace_id, remote }), remote).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Unknown remote/),
    })
  }

  // Naming a remote pushes the same-named branch there and records the upstream.
  const first = await git(profile, 'review.push', { workspace_id, remote: 'origin', index_token: await token() })
  expect(first).toMatchObject({
    status: 'succeeded',
    result: { branch: 'topic', remote: 'origin', remote_ref: 'refs/heads/topic', upstream_set: true, verified: true },
  })
  expect(await repo.git('config', 'branch.topic.remote')).toBe('origin')
  expect(await repo.git('config', 'branch.topic.merge')).toBe('refs/heads/topic')
  expect(await remoteHead(repo, bare, 'topic')).toBe(await repo.head())
  // Another remote can receive the branch without taking over the upstream.
  expect(
    await git(profile, 'review.push', { workspace_id, remote: 'mirror', index_token: await token() }),
  ).toMatchObject({ status: 'succeeded', result: { remote: 'mirror', upstream_set: false } })
  expect(await remoteHead(repo, mirror, 'topic')).toBe(await repo.head())
  expect(await repo.git('config', 'branch.topic.remote')).toBe('origin')
  // Later pushes follow the upstream.
  await repo.commit('More topic', { 'topic.txt': 'topic 2\n' })
  expect(await git(profile, 'review.push', { workspace_id, index_token: await token() })).toMatchObject({
    status: 'succeeded',
  })
  expect(await remoteHead(repo, bare, 'topic')).toBe(await repo.head())

  // An unreachable remote fails with Git's own message and changes nothing.
  const unreachable = await git(profile, 'review.fetch', { workspace_id, remote: 'gone' })
  expect(unreachable).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/git fetch failed: .*(does not appear|not a git repository|Could not read)/i),
  })
  expect(await git(profile, 'review.push', { workspace_id, remote: 'gone', index_token: await token() })).toMatchObject(
    { status: 'failed', error: expect.stringMatching(/git push failed/) },
  )

  // A detached HEAD cannot be pulled or pushed.
  await repo.git('switch', '--quiet', '--detach')
  expect(
    await git(profile, 'review.push', { workspace_id, remote: 'origin', index_token: await token() }),
  ).toMatchObject({ status: 'failed', error: expect.stringMatching(/detached/) })
})

test('a daemon killed while a push is in flight leaves an interrupted receipt, and the remote shows what happened', async ({
  ade,
}) => {
  const pause = join(ade.root, 'remote-pause')
  await mkdir(pause, { recursive: true })
  const profile = await ade.profile({
    env: { ADE_E2E_WORKER_PAUSE_ENABLED: '1', ADE_E2E_REVIEW_REMOTE_PAUSE_DIR: pause },
  })
  const repo = await ade.repo({ initialFiles: { 'app.txt': 'v1\n' } })
  const bare = await bareRemote(repo, join(ade.root, 'remotes', 'origin.git'), {})
  await repo.git('remote', 'add', 'origin', `file://${bare}`)
  await repo.git('fetch', '--quiet', 'origin')
  await repo.git('branch', '--quiet', '--set-upstream-to=origin/main', 'main')
  const before = await remoteHead(repo, bare)
  const head = await repo.commit('Pushed while the daemon dies', { 'app.txt': 'v2\n' })
  const workspace_id = await openWorkspace(profile, repo.path)
  const state = await status(profile, workspace_id)

  // Hold the push worker just before it runs `git push`, then kill the daemon.
  await writeFile(join(pause, 'armed'), '')
  const id = operationId('push')
  const admitted = await profile.call('review.push', { workspace_id, operation_id: id, index_token: state.index_token })
  expect(admitted.operation.status).toBe('running')
  await expect.poll(() => existsSync(join(pause, 'signal')), { timeout: 15_000 }).toBe(true)
  await profile.killDaemon()
  expect(await remoteHead(repo, bare)).toBe(before)
  await rm(join(pause, 'armed'))
  await writeFile(join(pause, 'release'), '')
  await profile.restartDaemon()

  // The orphaned worker finishes the push after its daemon died: the outcome
  // is uncertain to ADE, so the receipt says interrupted and never reruns.
  await expect.poll(() => remoteHead(repo, bare), { timeout: 15_000 }).toBe(head)
  await expect
    .poll(
      async () =>
        status(profile, workspace_id).then(
          () => 'ok',
          (error) => String(error),
        ),
      { timeout: 15_000 },
    )
    .toBe('ok')
  const receipt = (await profile.call('review.operation', { workspace_id, operation_id: id })).operation
  expect(receipt).toMatchObject({
    id,
    op: 'review.push',
    status: 'interrupted',
    error: expect.stringMatching(/inspect Git history/),
  })
  const retry = await profile.call('review.push', { workspace_id, operation_id: id, index_token: state.index_token })
  expect(retry.operation.status).toBe('interrupted')
  expect(
    (await profile.call('review.operation.list', { workspace_id })).operations.map((entry) => entry.operation.id),
  ).toEqual([id])

  // A fetch shows the truth, and a new push with a new ID is a no-op success.
  const fetched = await git(profile, 'review.fetch', { workspace_id })
  expect(fetched).toMatchObject({ status: 'succeeded' })
  expect(await repo.git('rev-parse', 'origin/main')).toBe(head)
  expect(
    await git(profile, 'review.push', { workspace_id, index_token: (await status(profile, workspace_id)).index_token }),
  ).toMatchObject({ status: 'succeeded', result: { head, verified: true } })
  await profile.call('review.operation.acknowledge', { workspace_id, operation_id: id })
  expect((await profile.call('review.operation.list', { workspace_id })).operations).toEqual([])
})
