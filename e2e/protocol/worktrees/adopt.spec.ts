// F065: external trees stay protected until an explicit, confirmed adoption;
// a supported pull-request source resolves into a checkout through a fetch.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test } from '../fixtures'
import { create, createReady, item, operationId, register, settled } from './lifecycle'

test('an external tree is protected until a confirmed adoption, which grants removal authority', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo()
  const other = await ade.repo({ name: 'other' })
  const repositoryId = await register(profile, repo)
  const external = join(dirname(repo.path), 'external')
  await repo.git('worktree', 'add', '--quiet', '-b', 'external', external)
  const foreign = join(dirname(other.path), 'foreign')
  await other.git('worktree', 'add', '--quiet', '-b', 'foreign', foreign)

  // Opening an external tree takes no removal authority.
  await profile.call('workspace.open', { path: external })
  const refresh = operationId('refresh')
  await profile.call('worktree.refresh', { repository_id: repositoryId, operation_id: refresh })
  await settled(profile, repositoryId, refresh)
  expect(await item(profile, repositoryId, external)).toMatchObject({ ade_owned: false })
  await expect(
    profile.call('worktree.remove', {
      repository_id: repositoryId,
      operation_id: operationId('remove'),
      path: external,
    }),
  ).rejects.toThrow()
  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  expect(plan.trees.find((tree) => tree.path === external)?.blockers).toEqual(['external'])

  // Adoption needs the exact confirmed path, a linked tree of this repository, and not the primary.
  const adopt = (path: string, confirm_path?: string) =>
    profile.call('worktree.adopt', {
      repository_id: repositoryId,
      path,
      ...(confirm_path ? { confirm_path } : {}),
    } as never)
  await expect(adopt(external)).rejects.toThrow(/confirm_path/)
  await expect(adopt(external, `${external}/`)).rejects.toThrow(/confirm_path/)
  await expect(adopt(repo.path, repo.path)).rejects.toThrow(/primary checkout cannot be adopted/)
  await expect(adopt(foreign, foreign)).rejects.toThrow(/not an available linked worktree|another repository/)
  expect(await item(profile, repositoryId, external)).toMatchObject({ ade_owned: false })

  const adopted = await adopt(external, external)
  expect(adopted.worktrees.find((tree) => tree.path === external)).toMatchObject({ ade_owned: true })
  await expect(adopt(external, external)).rejects.toThrow(/already has ADE removal authority/)

  // With authority, removal works like any owned tree; the branch is kept.
  const removal = operationId('remove-adopted')
  await profile.call('worktree.remove', { repository_id: repositoryId, operation_id: removal, path: external })
  expect(await settled(profile, repositoryId, removal)).toMatchObject({ status: 'succeeded' })
  expect(existsSync(external)).toBe(false)
  expect(await repo.git('branch', '--list', 'external')).toContain('external')
  // The other repository's tree was never touched.
  expect(existsSync(foreign)).toBe(true)
})

test('a tree replaced at the same path loses the authority granted to the old one', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const repositoryId = await register(profile, repo)
  const path = join(dirname(repo.path), 'replaced')
  await repo.git('worktree', 'add', '--quiet', '-b', 'first', path)
  await profile.call('worktree.adopt', { repository_id: repositoryId, path, confirm_path: path })

  // Something outside ADE replaces the tree with another checkout at the same path.
  await repo.git('worktree', 'remove', path)
  await repo.git('worktree', 'add', '--quiet', '-b', 'second', path)

  const plan = await profile.call('worktree.cleanup.plan', { repository_id: repositoryId })
  const blockers = plan.trees.find((tree) => tree.path === path)?.blockers ?? []
  expect(
    blockers.some((blocker) => blocker === 'authority_changed' || blocker === 'external'),
    JSON.stringify(blockers),
  ).toBe(true)
  await expect(
    profile.call('worktree.remove', { repository_id: repositoryId, operation_id: operationId('remove'), path }),
  ).rejects.toThrow()
  expect(existsSync(path)).toBe(true)
  expect(await repo.git('-C', path, 'branch', '--show-current')).toBe('second')
})

test('adoption is refused while another profile holds a removal claim on the tree', async ({ ade }) => {
  const shared = { ADE_HOST_RESOURCES_HOME: join(ade.root, 'host-resources') }
  const owner = await ade.profile({ env: shared })
  const other = await ade.profile({ env: shared })
  const repo = await ade.repo()
  const ownerRepository = await register(owner, repo)
  const otherRepository = await register(other, repo)
  const tree = await createReady(owner, ownerRepository, { name: 'claimed' })

  // The owner's teardown holds the exclusive removal claim until released.
  const started = join(ade.root, 'teardown-started')
  const release = join(ade.root, 'teardown-release')
  await owner.call('worktree.configure', {
    repository_id: ownerRepository,
    config: {
      teardown: [
        {
          name: 'wait',
          command: ['/bin/sh', '-c', `: > '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`],
          timeout_seconds: 60,
        },
      ],
    },
  })
  const removal = operationId('remove-claimed')
  await owner.call('worktree.remove', { repository_id: ownerRepository, operation_id: removal, path: tree })
  await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true)
  try {
    const refused = await other
      .call('worktree.adopt', { repository_id: otherRepository, path: tree, confirm_path: tree })
      .then(
        () => null,
        (error: unknown) => String(error),
      )
    expect(refused).toMatch(/conflicts with the active exclusive remove claim/)
    const plan = await other.call('worktree.cleanup.plan', { repository_id: otherRepository })
    expect(plan.trees.find((candidate) => candidate.path === tree)?.blockers).toEqual(
      expect.arrayContaining(['external', 'claim_held']),
    )
  } finally {
    await writeFile(release, '')
  }
  expect(await settled(owner, ownerRepository, removal)).toMatchObject({ status: 'succeeded' })
  expect(existsSync(tree)).toBe(false)
})

test('a pull-request head fetched from a configured remote becomes a new tree; unknown remotes, URLs and missing refs are refused', async ({
  ade,
  profile,
}) => {
  const upstream = await ade.repo({ name: 'upstream' })
  await upstream.git('checkout', '--quiet', '-b', 'contributor')
  const prHead = await upstream.commit('Contributor change', { 'pr.txt': 'from the pull request\n' })
  await upstream.git('update-ref', 'refs/pull/7/head', prHead)
  await upstream.git('checkout', '--quiet', 'main')
  await upstream.git('branch', '--quiet', '-D', 'contributor')

  const repo = await ade.repo()
  await repo.git('remote', 'add', 'origin', upstream.path)
  const repositoryId = await register(profile, repo)

  // Through the CLI, as a user would: --pr N fetches refs/pull/N/head from origin.
  const id = operationId('create-pr')
  const cli = await profile.cli('worktree', 'new', repositoryId, '--name', 'pr-7', '--pr', '7', '--request-id', id)
  expect(cli.code, cli.stderr).toBe(0)
  const created = await settled(profile, repositoryId, id)
  expect(created, JSON.stringify(created)).toMatchObject({
    status: 'succeeded',
    result: { resolved: { branch: 'pr-7', base: prHead, fetch: { remote: 'origin', ref: 'refs/pull/7/head' } } },
  })
  const tree = created.worktree_path!
  expect(await repo.git('-C', tree, 'rev-parse', 'HEAD')).toBe(prHead)
  expect(await readFile(join(tree, 'pr.txt'), 'utf8')).toBe('from the pull request\n')
  expect(await repo.git('rev-parse', created.result!.resolved.fetch.local)).toBe(prHead)
  // Only the fetch happened: no remote-tracking branches or tags were added.
  expect(await repo.git('for-each-ref', '--format=%(refname)', 'refs/remotes', 'refs/tags')).toBe('')

  const refusals: Array<[{ remote: string; ref: string }, RegExp]> = [
    [{ remote: 'upstream', ref: 'refs/pull/7/head' }, /not a configured remote/],
    [{ remote: upstream.path, ref: 'refs/pull/7/head' }, /not a configured remote/],
    [{ remote: 'origin', ref: 'refs/pull/7/head:refs/heads/x' }, /full ref/],
    [{ remote: 'origin', ref: 'pull/7/head' }, /full ref/],
    [{ remote: 'origin', ref: 'refs/pull/8/head' }, /Could not fetch/],
  ]
  const before = await repo.git('worktree', 'list', '--porcelain')
  for (const [fetch, message] of refusals) {
    const refused = await create(profile, repositoryId, {
      name: `refused-${refusals.findIndex(([f]) => f === fetch)}`,
      fetch,
    })
    expect(refused, JSON.stringify(fetch)).toMatchObject({ status: 'failed' })
    expect(refused.error).toMatch(message)
  }
  expect(await repo.git('worktree', 'list', '--porcelain')).toBe(before)
  // A fetched source replaces base; both together are refused at admission.
  await expect(
    profile.call('worktree.create', {
      repository_id: repositoryId,
      operation_id: operationId('both'),
      base: 'main',
      fetch: { remote: 'origin', ref: 'refs/pull/7/head' },
    }),
  ).rejects.toThrow(/one or the other/)
})
