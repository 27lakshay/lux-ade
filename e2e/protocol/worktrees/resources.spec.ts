// F068: explicit ignored-resource rules. Copies are owned by the tree, links
// point at the primary checkout's resource, which cleanup leaves alone.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '../fixtures'
import { create, createReady, item, operationId, register, settled } from './lifecycle'

const execFileAsync = promisify(execFile)

// `node_modules` without a slash ignores a link too; `deps/` ignores only a directory.
const ignored = { '.gitignore': '.env\nnode_modules\ndeps/\ncache/\nlinked\npipe\n', 'config.json': '{}\n' }

type ResourceResult = { path: string; outcome: string; error?: string }
const outcomesOf = (results: unknown) =>
  Object.fromEntries((results as ResourceResult[]).map((result) => [result.path, result.outcome]))

test('rules copy, link and skip ignored resources, report tracked and missing paths, and never replace an existing file', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: ignored })
  await repo.write('.env', 'SECRET=primary\n')
  await repo.write('node_modules/pkg/index.js', 'module.exports = 1\n')
  await repo.write('deps/lib.js', 'lib\n')
  await repo.write('cache/blob', 'cached\n')
  await repo.write('unlisted.env', 'never copied\n')
  const repositoryId = await register(profile, repo)
  await profile.call('worktree.configure', {
    repository_id: repositoryId,
    config: {
      resources: [
        { path: '.env', mode: 'copy' },
        { path: 'node_modules', mode: 'link' },
        { path: 'deps', mode: 'link' },
        { path: 'cache', mode: 'skip' },
        { path: 'config.json', mode: 'copy' },
        { path: 'missing.env', mode: 'copy' },
      ],
    },
  })

  const created = await create(profile, repositoryId, { name: 'resources' })
  expect(created, JSON.stringify(created)).toMatchObject({ status: 'succeeded' })
  const tree = created.worktree_path!
  expect(outcomesOf(created.result!.resources)).toEqual({
    '.env': 'copied',
    node_modules: 'linked',
    deps: 'not_ignored',
    cache: 'skipped',
    'config.json': 'not_ignored',
    'missing.env': 'missing',
  })

  // The copy is independent; the link points at the primary checkout's directory.
  expect(await readFile(join(tree, '.env'), 'utf8')).toBe('SECRET=primary\n')
  expect(lstatSync(join(tree, '.env')).isSymbolicLink()).toBe(false)
  expect(lstatSync(join(tree, 'node_modules')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(tree, 'node_modules'))).toBe(join(repo.path, 'node_modules'))
  expect(existsSync(join(tree, 'cache'))).toBe(false)
  expect(existsSync(join(tree, 'unlisted.env'))).toBe(false)
  // A link Git would not ignore is taken back, so the tree stays clean.
  expect(existsSync(join(tree, 'deps'))).toBe(false)
  expect((created.result!.resources as ResourceResult[]).find((result) => result.path === 'deps')?.error).toMatch(
    /without a trailing slash/,
  )
  expect(await repo.git('-C', tree, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  // The tracked file is the tree's own checkout, not a copy.
  expect(await readFile(join(tree, 'config.json'), 'utf8')).toBe('{}\n')

  // Applying again never replaces what the tree now holds.
  await writeFile(join(tree, '.env'), 'SECRET=tree\n')
  const again = operationId('resources-again')
  await profile.call('worktree.resources.apply', { repository_id: repositoryId, operation_id: again, path: tree })
  const reapplied = await settled(profile, repositoryId, again)
  expect(reapplied, JSON.stringify(reapplied)).toMatchObject({ status: 'succeeded' })
  expect(outcomesOf(reapplied.result!.resources)).toMatchObject({ '.env': 'conflict', node_modules: 'conflict' })
  expect(await readFile(join(tree, '.env'), 'utf8')).toBe('SECRET=tree\n')
  expect(await readFile(join(repo.path, '.env'), 'utf8')).toBe('SECRET=primary\n')

  // Ignored resources do not make the tree dirty; cleanup removes the copy
  // and the link, and the linked resource in the primary checkout survives.
  const id = operationId('cleanup')
  await profile.call('worktree.cleanup', { repository_id: repositoryId, operation_id: id, paths: [tree] })
  const cleaned = await settled(profile, repositoryId, id)
  expect(cleaned, JSON.stringify(cleaned)).toMatchObject({ status: 'succeeded' })
  expect(existsSync(tree)).toBe(false)
  expect(await readFile(join(repo.path, 'node_modules/pkg/index.js'), 'utf8')).toBe('module.exports = 1\n')
  expect(await readFile(join(repo.path, '.env'), 'utf8')).toBe('SECRET=primary\n')
})

test('an unsafe source stops creation before setup and keeps the tree; a path beyond a link is never copied', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: ignored })
  const outside = join(dirname(repo.path), 'outside-secrets')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.env'), 'outside\n')
  await symlink(outside, join(repo.path, 'linked'))
  await execFileAsync('mkfifo', [join(repo.path, 'pipe')])
  const repositoryId = await register(profile, repo)
  const setupRan = join(ade.root, 'setup-ran')
  await profile.call('worktree.configure', {
    repository_id: repositoryId,
    config: {
      resources: [
        { path: 'linked/secret.env', mode: 'copy' },
        { path: 'pipe', mode: 'copy' },
      ],
      setup: [{ name: 'mark', command: ['/bin/sh', '-c', `: > '${setupRan}'`] }],
    },
  })

  const created = await create(profile, repositoryId, { name: 'unsafe' })
  expect(created, JSON.stringify(created)).toMatchObject({ status: 'failed', code: 'resource_failed' })
  // Git will not answer for a path beyond a symbolic link, so it is not treated as ignored.
  expect(outcomesOf(created.result!.resources)).toEqual({ 'linked/secret.env': 'not_ignored', pipe: 'unsafe' })
  const tree = created.worktree_path!
  expect(existsSync(tree)).toBe(true)
  expect(existsSync(join(tree, 'linked'))).toBe(false)
  expect(existsSync(join(tree, 'pipe'))).toBe(false)
  // Setup hooks never ran; the tree is kept and marked failed.
  expect(existsSync(setupRan)).toBe(false)
  const refreshed = operationId('refresh')
  await profile.call('worktree.refresh', { repository_id: repositoryId, operation_id: refreshed })
  await settled(profile, repositoryId, refreshed)
  expect(await item(profile, repositoryId, tree)).toMatchObject({ phase: 'setup_failed' })
})

test('configuration refuses globs, parent paths, .git and overlapping rules', async ({ ade, profile }) => {
  const repo = await ade.repo()
  const repositoryId = await register(profile, repo)
  for (const resources of [
    [{ path: '*.env', mode: 'copy' as const }],
    [{ path: '../outside', mode: 'copy' as const }],
    [{ path: '.git/config', mode: 'copy' as const }],
    [
      { path: 'node_modules', mode: 'link' as const },
      { path: 'node_modules/pkg', mode: 'copy' as const },
    ],
  ]) {
    await expect(
      profile.call('worktree.configure', { repository_id: repositoryId, config: { resources } }),
      JSON.stringify(resources),
    ).rejects.toThrow()
  }
  const state = await profile.call('worktree.get', { repository_id: repositoryId })
  expect(state.repository.config.resources ?? []).toEqual([])
  await createReady(profile, repositoryId, { name: 'plain' })
})
