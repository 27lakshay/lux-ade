// F075 discard: restore only the reviewed tracked worktree bytes from the
// index, refuse changed or unsafe state, and never lose a concurrent edit. The
// races pause the daemon's discard worker at a named step through its debug
// pause directories (ADE_E2E_DISCARD_*_DIR), then edit the file before release.
// Ported from the legacy e2e/specs/git-discard spec.
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, type AdeHarness, type ScratchProfile } from '../fixtures'
import { sendAndLoseReply } from '../fixtures/lost-reply'
import { git, openWorkspace, settled } from './steps'

/** Review a file the way a client does before discarding it: status revision plus diff token. */
async function reviewed(profile: ScratchProfile, workspace_id: string, path: string) {
  const status = await profile.call('review.status', { workspace_id, force: true })
  const diff = await profile.call('review.diff', { workspace_id, path, staged: false })
  return { workspace_id, path, revision: status.revision, diff_token: diff.token }
}

/** A profile whose discard worker pauses at the step `variable` names until `release` appears in the returned directory. */
async function pausedAt(ade: AdeHarness, variable: string): Promise<{ profile: ScratchProfile; pause: string }> {
  const pause = join(ade.root, 'pause')
  await mkdir(pause, { recursive: true })
  const profile = await ade.profile({ env: { ADE_E2E_WORKER_PAUSE_ENABLED: '1', [variable]: pause } })
  return { profile, pause }
}

async function paused(pause: string): Promise<void> {
  await expect.poll(() => existsSync(join(pause, 'signal')), { timeout: 15_000 }).toBe(true)
}

test('discard restores only reviewed tracked worktree bytes and refuses changed or unsafe state', async ({
  ade,
  profile,
}) => {
  const binaryBaseline = Buffer.from([0, 1, 2, 3, 4])
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await writeFile(join(repo.path, 'binary.dat'), binaryBaseline)
  await repo.git('add', '--', 'binary.dat')
  await repo.commit('binary baseline')
  const workspace_id = await openWorkspace(profile, repo.path)
  const read = (path: string) => repo.read(path)

  // A reviewed file with staged and unstaged changes: discard restores the
  // worktree from the index and never replaces the staged bytes.
  await repo.write('tracked.txt', 'staged\n')
  await repo.git('add', '--', 'tracked.txt')
  await repo.write('tracked.txt', 'unstaged\n')
  const indexBefore = await repo.git('rev-parse', ':tracked.txt')
  const discard = { ...(await reviewed(profile, workspace_id, 'tracked.txt')), operation_id: 'discard-reviewed' }
  const first = await git(profile, 'review.discard', discard)
  expect(first.status).toBe('succeeded')
  expect(await readFile(first.backup_path!, 'utf8')).toBe('unstaged\n')
  expect(await read('tracked.txt')).toBe('staged\n')
  expect(await repo.git('rev-parse', ':tracked.txt')).toBe(indexBefore)

  // Binary content, and a deleted tracked file, come back byte for byte.
  await writeFile(join(repo.path, 'binary.dat'), Buffer.from([0, 5, 6, 7, 8]))
  expect((await git(profile, 'review.discard', await reviewed(profile, workspace_id, 'binary.dat'))).status).toBe(
    'succeeded',
  )
  expect(await readFile(join(repo.path, 'binary.dat'))).toEqual(binaryBaseline)
  await rm(join(repo.path, 'binary.dat'))
  const restored = await git(profile, 'review.discard', await reviewed(profile, workspace_id, 'binary.dat'))
  expect(restored.status).toBe('succeeded')
  expect(restored.backup_path).toBeUndefined()
  expect(await readFile(join(repo.path, 'binary.dat'))).toEqual(binaryBaseline)

  // The first discard replays by ID and refuses another path under the same ID.
  expect((await profile.call('review.discard', discard)).operation).toMatchObject({ status: 'succeeded' })
  await expect(profile.call('review.discard', { ...discard, path: 'other.txt' })).rejects.toThrow(
    /different parameters/i,
  )

  // The CLI discards with the reviewed revision and diff token.
  await repo.write('tracked.txt', 'CLI draft\n')
  const cliStatus = await profile.cli('git', 'status', workspace_id)
  const cliDiff = await profile.cli('git', 'diff', workspace_id, 'tracked.txt')
  const cliResult = await profile.cli(
    'git',
    'discard',
    workspace_id,
    'tracked.txt',
    cliStatus.json!.revision as string,
    cliDiff.json!.token as string,
    '--operation-id',
    'discard-cli',
  )
  expect(cliResult.json).toMatchObject({ operation_id: 'discard-cli', workspace_id })
  expect((await settled(profile, workspace_id, 'discard-cli')).status).toBe('succeeded')
  expect(await read('tracked.txt')).toBe('staged\n')
  expect(await repo.git('rev-parse', ':tracked.txt')).toBe(indexBefore)

  // An edit after review makes the discard stale; the newer bytes stay.
  await repo.write('tracked.txt', 'first draft\n')
  const stale = await reviewed(profile, workspace_id, 'tracked.txt')
  await repo.write('tracked.txt', 'newer draft\n')
  expect((await git(profile, 'review.discard', stale)).status).toBe('failed')
  expect(await read('tracked.txt')).toBe('newer draft\n')
  expect(await repo.git('rev-parse', ':tracked.txt')).toBe(indexBefore)

  // An untracked file is never deleted.
  await repo.write('new.txt', 'do not delete\n')
  expect((await git(profile, 'review.discard', await reviewed(profile, workspace_id, 'new.txt'))).status).toBe('failed')
  expect(await read('new.txt')).toBe('do not delete\n')

  // A dirty submodule is tracked, but its nested repository is not an
  // ordinary file that ADE may restore on the user's behalf.
  const subsource = await ade.repo({ name: 'subsource', initialFiles: { 'nested.txt': 'nested baseline\n' } })
  await repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subsource.path, 'vendor')
  await repo.commit('add submodule')
  await repo.write('vendor/nested.txt', 'nested draft\n')
  expect((await git(profile, 'review.discard', await reviewed(profile, workspace_id, 'vendor'))).status).toBe('failed')
  expect(await read('vendor/nested.txt')).toBe('nested draft\n')

  // Traversal is invalid even with otherwise valid review tokens.
  const traversal = { ...stale, path: '../outside.txt', operation_id: 'discard-traversal' }
  try {
    expect((await git(profile, 'review.discard', traversal)).status).toBe('failed')
  } catch (error) {
    expect(String(error)).toMatch(/path|repository|invalid/i)
  }
  expect(await read('tracked.txt')).toBe('newer draft\n')

  // A conflicted path has no unambiguous index version to restore.
  await repo.git('submodule', 'deinit', '-f', '-q', '--', 'vendor')
  await rm(join(repo.path, 'new.txt'))
  await repo.git('restore', '--', 'tracked.txt')
  await repo.git('branch', 'side')
  await repo.write('tracked.txt', 'main change\n')
  await repo.git('commit', '-qam', 'main change')
  await repo.git('switch', '-q', 'side')
  await repo.write('tracked.txt', 'side change\n')
  await repo.git('commit', '-qam', 'side change')
  await repo.git('merge', 'main').catch(() => undefined)
  expect((await git(profile, 'review.discard', await reviewed(profile, workspace_id, 'tracked.txt'))).status).toBe(
    'failed',
  )
  expect(await read('tracked.txt')).toContain('<<<<<<<')
})

test('a discarded file is reconcilable by operation ID after losing the admission reply', async ({ ade, profile }) => {
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', 'draft\n')
  const workspace_id = await openWorkspace(profile, repo.path)
  const discard = {
    op: 'review.discard',
    ...(await reviewed(profile, workspace_id, 'tracked.txt')),
    operation_id: 'discard-lost-reply',
  }
  // The daemon admits the discard, then the connection drops before its reply is read.
  await sendAndLoseReply(profile, discard)
  let receipt: unknown
  await expect
    .poll(async () => {
      receipt = await profile
        .call('review.operation', { workspace_id, operation_id: discard.operation_id })
        .then((reply) => reply.operation)
        .catch(() => undefined)
      return (receipt as { status?: string } | undefined)?.status
    })
    .toBe('succeeded')
  expect(await repo.read('tracked.txt')).toBe('baseline\n')
  const { op: _op, ...request } = discard
  expect((await profile.call('review.discard', request)).operation).toEqual(receipt)
})

test('an edit after the final discard precondition is not overwritten', async ({ ade }) => {
  const { profile, pause } = await pausedAt(ade, 'ADE_E2E_DISCARD_BEFORE_APPLY_DIR')
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', 'reviewed draft\n')
  const workspace_id = await openWorkspace(profile, repo.path)
  const request = { ...(await reviewed(profile, workspace_id, 'tracked.txt')), operation_id: 'discard-final-race' }
  await profile.call('review.discard', request)
  await paused(pause)
  await repo.write('tracked.txt', 'newer edit\n')
  await writeFile(join(pause, 'release'), '')
  expect((await settled(profile, workspace_id, request.operation_id)).status).toBe('failed')
  expect(await repo.read('tracked.txt')).toBe('newer edit\n')
})

test('a concurrent edit at a different offset remains intact', async ({ ade }) => {
  const { profile, pause } = await pausedAt(ade, 'ADE_E2E_DISCARD_AFTER_CHECK_DIR')
  const baseline = Array.from({ length: 105 }, (_, index) => (index === 52 ? 'ORIGINAL' : `line-${index}`))
  const draft = baseline.map((line, index) => (index === 52 ? 'DRAFT' : line))
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': `${baseline.join('\n')}\n` } })
  await repo.write('tracked.txt', `${draft.join('\n')}\n`)
  const workspace_id = await openWorkspace(profile, repo.path)
  const request = { ...(await reviewed(profile, workspace_id, 'tracked.txt')), operation_id: 'discard-offset' }
  await profile.call('review.discard', request)
  await paused(pause)
  const newer = [...draft]
  newer[52] = 'NEWER'
  newer.push(...draft.slice(49, 56))
  const newerBytes = `${newer.join('\n')}\n`
  await repo.write('tracked.txt', newerBytes)
  await writeFile(join(pause, 'release'), '')
  expect((await settled(profile, workspace_id, request.operation_id)).status).toBe('failed')
  expect(await repo.read('tracked.txt')).toBe(newerBytes)
})

test('an edit to the displaced file during exchange is restored without losing either version', async ({ ade }) => {
  const { profile, pause } = await pausedAt(ade, 'ADE_E2E_DISCARD_AFTER_SWAP_DIR')
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', 'reviewed draft\n')
  const workspace_id = await openWorkspace(profile, repo.path)
  const request = { ...(await reviewed(profile, workspace_id, 'tracked.txt')), operation_id: 'discard-swap-race' }
  await profile.call('review.discard', request)
  await paused(pause)
  const displacedPath = await readFile(join(pause, 'signal'), 'utf8')
  expect(await repo.read('tracked.txt')).toBe('baseline\n')
  expect(await readFile(displacedPath, 'utf8')).toBe('reviewed draft\n')
  await writeFile(displacedPath, 'newer edit\n')
  await writeFile(join(pause, 'release'), '')
  const receipt = await settled(profile, workspace_id, request.operation_id)
  expect(receipt.status).toBe('failed')
  expect(receipt.backup_path).toBe(displacedPath)
  expect(await repo.read('tracked.txt')).toBe('newer edit\n')
  expect(await readFile(displacedPath, 'utf8')).toBe('baseline\n')
})

test('a daemon crash after exchange exposes the retained file and never replays discard', async ({ ade }) => {
  const { profile, pause } = await pausedAt(ade, 'ADE_E2E_DISCARD_AFTER_SWAP_DIR')
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', 'reviewed draft\n')
  const workspace_id = await openWorkspace(profile, repo.path)
  const request = {
    ...(await reviewed(profile, workspace_id, 'tracked.txt')),
    operation_id: 'discard-crash-after-swap',
  }
  await profile.call('review.discard', request)
  await paused(pause)
  const displacedPath = await readFile(join(pause, 'signal'), 'utf8')
  expect(await repo.read('tracked.txt')).toBe('baseline\n')
  expect(await readFile(displacedPath, 'utf8')).toBe('reviewed draft\n')

  await profile.restartDaemon('kill')
  const receipt = (await profile.call('review.operation', { workspace_id, operation_id: request.operation_id }))
    .operation
  expect(receipt).toMatchObject({ status: 'interrupted', backup_path: displacedPath })
  expect((await profile.call('review.discard', request)).operation).toEqual(receipt)
  // The replay ran nothing: no operation is running and both versions are where the crash left them.
  expect(
    (await profile.call('review.operation.list', { workspace_id })).operations.map((entry) => entry.operation.status),
  ).not.toContain('running')
  expect(existsSync(join(pause, 'release'))).toBe(false)
  expect(await repo.read('tracked.txt')).toBe('baseline\n')
  expect(await readFile(displacedPath, 'utf8')).toBe('reviewed draft\n')
})

test('a replaced ancestor cannot redirect discard outside the workspace', async ({ ade }) => {
  const { profile, pause } = await pausedAt(ade, 'ADE_E2E_DISCARD_BEFORE_SWAP_DIR')
  const repo = await ade.repo({ initialFiles: { 'nested/tracked.txt': 'baseline\n' } })
  const outside = join(dirname(repo.path), 'outside')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'tracked.txt'), 'outside untouched\n')
  await repo.write('nested/tracked.txt', 'reviewed draft\n')
  const workspace_id = await openWorkspace(profile, repo.path)
  const request = {
    ...(await reviewed(profile, workspace_id, 'nested/tracked.txt')),
    operation_id: 'discard-replaced-ancestor',
  }
  await profile.call('review.discard', request)
  await paused(pause)
  await rename(join(repo.path, 'nested'), join(repo.path, 'moved'))
  await symlink(outside, join(repo.path, 'nested'))
  await writeFile(join(pause, 'release'), '')
  expect((await settled(profile, workspace_id, request.operation_id)).status).toBe('failed')
  expect(await readFile(join(outside, 'tracked.txt'), 'utf8')).toBe('outside untouched\n')
  expect(await repo.read('moved/tracked.txt')).toBe('reviewed draft\n')
})

test('a writer holding the old inode can recover its later bytes from the reported backup', async ({ ade }) => {
  const { profile, pause } = await pausedAt(ade, 'ADE_E2E_DISCARD_AFTER_DISPLACED_CHECK_DIR')
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', 'reviewed draft\n')
  const writer = await open(join(repo.path, 'tracked.txt'), 'r+')
  try {
    const workspace_id = await openWorkspace(profile, repo.path)
    const request = { ...(await reviewed(profile, workspace_id, 'tracked.txt')), operation_id: 'discard-open-fd' }
    await profile.call('review.discard', request)
    await paused(pause)
    const displacedPath = await readFile(join(pause, 'signal'), 'utf8')
    await writer.truncate(0)
    await writer.writeFile('later writer bytes\n')
    await writer.sync()
    await writeFile(join(pause, 'release'), '')
    const receipt = await settled(profile, workspace_id, request.operation_id)
    expect(receipt).toMatchObject({ status: 'succeeded', backup_path: displacedPath })
    expect(await repo.read('tracked.txt')).toBe('baseline\n')
    expect(await readFile(displacedPath, 'utf8')).toBe('later writer bytes\n')
  } finally {
    await writer.close()
  }
})

test('discard restores the index of a linked worktree without changing its primary checkout', async ({
  ade,
  profile,
}) => {
  const primary = await ade.repo({ initialFiles: { 'tracked.txt': 'primary baseline\n' } })
  const linked = join(dirname(primary.path), 'linked')
  await primary.git('worktree', 'add', '-q', '-b', 'linked', linked)
  await writeFile(join(linked, 'tracked.txt'), 'linked staged\n')
  await primary.git('-C', linked, 'add', '--', 'tracked.txt')
  await writeFile(join(linked, 'tracked.txt'), 'linked draft\n')
  const workspace_id = await openWorkspace(profile, linked)
  const receipt = await git(profile, 'review.discard', await reviewed(profile, workspace_id, 'tracked.txt'))
  expect(receipt.status).toBe('succeeded')
  expect(await readFile(join(linked, 'tracked.txt'), 'utf8')).toBe('linked staged\n')
  expect(await primary.git('-C', linked, 'show', ':tracked.txt')).toBe('linked staged')
  expect(await primary.read('tracked.txt')).toBe('primary baseline\n')
  expect(await readFile(receipt.backup_path!, 'utf8')).toBe('linked draft\n')
})
