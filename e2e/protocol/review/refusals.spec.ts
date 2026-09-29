// The daemon checks every review request itself (daemon authority ticket 08):
// a diff of a file the status does not list, or of a side with no changes, is
// `review_file_unavailable`; a Git mutation with a path outside the tree, a
// token Changes never showed or a blank message is refused before any receipt
// is kept, so the same operation ID stays free.
import { expect, test, type ScratchProfile, type ScratchRepo } from '../fixtures'

async function changed(profile: ScratchProfile, repo: ScratchRepo) {
  await repo.commit('Track a file', { 'tracked.txt': 'baseline\n' })
  await repo.write('tracked.txt', 'baseline\nchanged\n')
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  return workspace.id
}

async function refusal(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error('The call was expected to be refused')
    },
    (failure: unknown) => failure as { code: string; recovery?: string; message: string },
  )
}

test('a diff of an unchanged file or of a side with no changes is review_file_unavailable', async ({
  profile,
  repo,
}) => {
  const workspace_id = await changed(profile, repo)
  expect((await profile.call('review.diff', { workspace_id, path: 'tracked.txt', staged: false })).path).toBe(
    'tracked.txt',
  )
  for (const request of [
    { workspace_id, path: 'missing.txt', staged: false },
    { workspace_id, path: 'tracked.txt', staged: true },
  ]) {
    for (const op of ['review.diff', 'review.diff_page'] as const) {
      const refused = await refusal(profile.call(op, request))
      expect(refused, `${op} ${JSON.stringify(request)}`).toMatchObject({
        code: 'review_file_unavailable',
        recovery: 'refresh_changes',
      })
    }
  }
  // The CLI reports the same code.
  const cli = await profile.cli('git', 'diff', workspace_id, 'missing.txt')
  expect(cli.code).toBe(34)
  expect(cli.json).toMatchObject({ code: 'review_file_unavailable' })
})

test('a Git mutation with a bad path, token or message is refused before its receipt is kept', async ({
  profile,
  repo,
}) => {
  const workspace_id = await changed(profile, repo)
  const status = await profile.call('review.status', { workspace_id, force: true })
  const diff = await profile.call('review.diff', { workspace_id, path: 'tracked.txt', staged: false })
  const operation_id = 'review-refused'
  for (const [op, request, message] of [
    ['review.stage', { path: '../outside.txt', revision: status.revision }, /repository-relative path/],
    ['review.stage', { path: 'tracked.txt', revision: 'not-a-token' }, /revision/],
    ['review.discard', { path: 'tracked.txt', revision: status.revision, diff_token: 'x' }, /diff_token/],
    ['review.commit', { message: '   ', index_token: status.index_token }, /message is empty/],
    ['review.commit', { message: 'Commit', index_token: 'nope' }, /index_token/],
  ] as const) {
    const refused = await refusal(
      profile.call(op as 'review.stage', { workspace_id, operation_id, ...request } as never),
    )
    expect(refused.message, `${op} ${JSON.stringify(request)}`).toMatch(message)
  }
  // Nothing was recorded under the ID, so it still runs the real request.
  const unknown = await refusal(profile.call('review.operation', { workspace_id, operation_id }))
  expect(unknown.message).toMatch(/Unknown review operation/)
  const staged = await profile.call('review.stage', {
    workspace_id,
    operation_id,
    path: 'tracked.txt',
    revision: status.revision,
  })
  expect(staged.operation.id).toBe(operation_id)
  expect(diff.token).toMatch(/^[0-9a-f]{16}$/)
})
