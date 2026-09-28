// F075 through the named CLI Git commands: they take the reviewed revision or
// index token, keep their receipts by request ID, report a pre-commit hook
// failure, and reconcile a mutation whose admission reply was lost.
// Ported from the legacy e2e/specs/git-cli-ordinary and review-mutations specs.
import { chmod, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ScratchProfile } from '../fixtures'
import { git, openWorkspace, status } from './steps'

/** Poll the receipt through the CLI until it leaves `running`. */
async function receipt(profile: ScratchProfile, workspaceId: string, requestId: string) {
  let operation: Record<string, unknown> | undefined
  await expect
    .poll(async () => {
      const result = await profile.cli('git', 'operation', workspaceId, requestId)
      expect(result.code, result.stderr).toBe(0)
      operation = result.json!.operation as Record<string, unknown>
      return operation.status
    })
    .not.toBe('running')
  return operation!
}

test('named CLI Git commands use reviewed revisions, preserve receipts and expose hook failures', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', 'first change\n')
  const workspaceId = await openWorkspace(profile, repo.path)
  const cached = () => repo.git('diff', '--cached', '--name-only')

  const initial = await profile.cli('git', 'status', workspaceId)
  expect(initial).toMatchObject({
    code: 0,
    json: { type: 'review_status', files: [expect.objectContaining({ path: 'tracked.txt', unstaged: true })] },
  })
  const oldRevision = initial.json!.revision as string
  // A mutation without a request ID is a usage error.
  expect((await profile.cli('git', 'stage', workspaceId, 'tracked.txt', oldRevision)).json).toMatchObject({
    code: 'usage',
  })

  // A stage against a stale revision is admitted, then fails without staging.
  await repo.write('tracked.txt', 'newer change\n')
  const staleId = 'git-cli-stale-stage'
  const stale = await profile.cli('git', 'stage', workspaceId, 'tracked.txt', oldRevision, '--request-id', staleId)
  expect(stale).toMatchObject({ code: 0, json: { request_id: staleId, workspace_id: workspaceId } })
  expect(await receipt(profile, workspaceId, staleId)).toMatchObject({ status: 'failed' })
  expect(await cached()).toBe('')

  const fresh = await profile.cli('git', 'status', workspaceId)
  const revision = fresh.json!.revision as string
  expect(revision).not.toBe(oldRevision)
  const stageId = 'git-cli-stage'
  const staged = await profile.cli('git', 'stage', workspaceId, 'tracked.txt', revision, '--request-id', stageId)
  expect(staged.json).toMatchObject({ request_id: stageId, workspace_id: workspaceId })
  expect(await receipt(profile, workspaceId, stageId)).toMatchObject({ status: 'succeeded' })
  const repeated = await profile.cli('git', 'stage', workspaceId, 'tracked.txt', revision, '--request-id', stageId)
  expect(repeated.json!.operation).toMatchObject({ id: stageId, status: 'succeeded' })
  const changed = await profile.cli('git', 'stage', workspaceId, 'another.txt', revision, '--request-id', stageId)
  expect(changed).toMatchObject({ code: 7, json: { code: 'daemon' } })
  expect(await cached()).toBe('tracked.txt')

  const stagedStatus = await profile.cli('git', 'status', workspaceId)
  await profile.cli(
    'git',
    'unstage',
    workspaceId,
    'tracked.txt',
    stagedStatus.json!.revision as string,
    '--request-id',
    'git-cli-unstage',
  )
  expect(await receipt(profile, workspaceId, 'git-cli-unstage')).toMatchObject({ status: 'succeeded' })
  expect(await cached()).toBe('')
  const unstagedStatus = await profile.cli('git', 'status', workspaceId)
  await profile.cli(
    'git',
    'stage',
    workspaceId,
    'tracked.txt',
    unstagedStatus.json!.revision as string,
    '--request-id',
    'git-cli-restage',
  )
  expect(await receipt(profile, workspaceId, 'git-cli-restage')).toMatchObject({ status: 'succeeded' })

  // A failing pre-commit hook fails the receipt and leaves HEAD where it was.
  const beforeCommit = await profile.cli('git', 'status', workspaceId)
  const oldHead = await repo.head()
  const hook = join(repo.path, '.git', 'hooks', 'pre-commit')
  await writeFile(hook, '#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n', { mode: 0o700 })
  await profile.cli(
    'git',
    'commit',
    workspaceId,
    'change',
    beforeCommit.json!.index_token as string,
    '--request-id',
    'git-cli-hook-failure',
  )
  expect(await receipt(profile, workspaceId, 'git-cli-hook-failure')).toMatchObject({ status: 'failed' })
  expect(await repo.head()).toBe(oldHead)
  await rm(hook)

  // An index changed outside ADE makes the reviewed token stale.
  const afterHook = await profile.cli('git', 'status', workspaceId)
  await repo.write('external.txt', 'external change\n')
  await repo.git('add', '--', 'external.txt')
  await profile.cli(
    'git',
    'commit',
    workspaceId,
    'change',
    afterHook.json!.index_token as string,
    '--request-id',
    'git-cli-stale-index',
  )
  expect(await receipt(profile, workspaceId, 'git-cli-stale-index')).toMatchObject({ status: 'failed' })
  expect(await repo.head()).toBe(oldHead)
  expect(await cached()).toBe('external.txt\ntracked.txt')
  await repo.git('reset', '-q', 'HEAD', '--', 'external.txt')

  const current = await profile.cli('git', 'status', workspaceId)
  const commitId = 'git-cli-commit'
  const token = current.json!.index_token as string
  await profile.cli('git', 'commit', workspaceId, 'change', token, '--request-id', commitId)
  const committed = await receipt(profile, workspaceId, commitId)
  expect(committed).toMatchObject({ status: 'succeeded', result: { head: expect.any(String) } })
  const newHead = await repo.head()
  expect(newHead).not.toBe(oldHead)
  expect((committed.result as { head: string }).head).toBe(newHead)
  const retry = await profile.cli('git', 'commit', workspaceId, 'change', token, '--request-id', commitId)
  expect(retry.json!.operation).toEqual(committed)
  expect(await repo.git('rev-list', '--count', 'HEAD')).toBe('2')
})

test('a commit blocked by a pre-commit hook fails its receipt; a commit replays by ID and refuses a changed message', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', 'updated\n')
  await repo.git('add', 'tracked.txt')
  const workspace_id = await openWorkspace(profile, repo.path)
  const headBefore = await repo.head()

  const hook = join(repo.path, '.git', 'hooks', 'pre-commit')
  await writeFile(hook, '#!/bin/sh\nexit 7\n')
  await chmod(hook, 0o755)
  const blocked = await git(profile, 'review.commit', {
    workspace_id,
    index_token: (await status(profile, workspace_id)).index_token,
    message: 'blocked by hook',
  })
  expect(blocked.status).toBe('failed')
  expect(await repo.head()).toBe(headBefore)
  await rm(hook)

  const commit = {
    workspace_id,
    operation_id: 'commit-once',
    index_token: (await status(profile, workspace_id)).index_token,
    message: 'ADE commit',
  }
  const completed = await git(profile, 'review.commit', commit)
  expect(completed.status).toBe('succeeded')
  const headAfter = await repo.head()
  expect(headAfter).not.toBe(headBefore)
  expect(completed.result?.head).toBe(headAfter)
  expect((await profile.call('review.commit', commit)).operation).toMatchObject({ status: 'succeeded' })
  await expect(profile.call('review.commit', { ...commit, message: 'different work' })).rejects.toThrow(
    /different parameters/i,
  )
  expect(await repo.head()).toBe(headAfter)
})

test('the CLI reconciles a Git mutation when its admission reply is lost', async ({ ade, profile }) => {
  const repo = await ade.repo()
  await repo.write('new.txt', 'one\n')
  const workspaceId = await openWorkspace(profile, repo.path)
  const initial = await profile.cli('git', 'status', workspaceId)
  const revision = initial.json!.revision as string

  // A proxy that forwards the CLI's first reply (its hello) and drops the second (the admission).
  const proxyPath = join(ade.root, 'drop.sock')
  const proxy = createServer((client) => {
    const upstream = createConnection(profile.socket)
    let replies = 0
    let frame = ''
    client.on('data', (bytes) => upstream.write(bytes))
    upstream.on('data', (bytes) => {
      frame += bytes.toString('utf8')
      for (;;) {
        const end = frame.indexOf('\n')
        if (end < 0) break
        const line = frame.slice(0, end + 1)
        frame = frame.slice(end + 1)
        if (++replies === 2) {
          client.destroy()
          upstream.destroy()
          break
        }
        client.write(line)
      }
    })
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    proxy.once('error', rejectListen)
    proxy.listen(proxyPath, resolveListen)
  })
  try {
    const requestId = 'git-cli-lost-admission'
    const lost = await profile.cliWith(
      {},
      '--socket',
      proxyPath,
      'git',
      'stage',
      workspaceId,
      'new.txt',
      revision,
      '--request-id',
      requestId,
    )
    expect(lost.code).not.toBe(0)
    const result = await receipt(profile, workspaceId, requestId)
    expect(result).toMatchObject({ id: requestId, status: 'succeeded' })
    const same = await profile.cli('git', 'stage', workspaceId, 'new.txt', revision, '--request-id', requestId)
    expect(same.json!.operation).toEqual(result)
    expect(await repo.git('diff', '--cached', '--name-only')).toBe('new.txt')
  } finally {
    await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()))
  }
})
