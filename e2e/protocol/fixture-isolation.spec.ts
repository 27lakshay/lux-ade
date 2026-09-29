import { existsSync } from 'node:fs'
import { readFile, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('scratch status reports changes without rewriting the index', async ({ repo }) => {
  const index = join(repo.path, '.git/index')
  const before = await readFile(index)
  // An unchanged file with different metadata makes ordinary git status refresh
  // the index. Polling it must not acquire the lock needed by an effect command.
  const touched = new Date(Date.now() - 60_000)
  await utimes(join(repo.path, 'README.md'), touched, touched)
  expect(await repo.status()).toEqual([])
  expect(await readFile(index)).toEqual(before)
  await repo.dirty('README.md', 'edited\n')
  expect(await repo.status()).toEqual([' M README.md'])
  expect(await readFile(index)).toEqual(before)
})

test('scratch repositories keep config, indexes and objects independent', async ({ ade }) => {
  const template = join(__dirname, 'fixtures/git-template/config')
  const original = await readFile(template, 'utf8')
  const first = await ade.repo({ initialFiles: { 'first.txt': 'first\n' } })
  const second = await ade.repo({ branch: 'isolated', initialFiles: { 'second.txt': 'second\n' } })
  expect(first.path).not.toBe(second.path)
  expect(await first.git('branch', '--show-current')).toBe('main')
  expect(await second.git('branch', '--show-current')).toBe('isolated')
  for (const repo of [first, second]) {
    // Specs install real hooks and exclusions in the normal Git directories.
    expect(existsSync(join(repo.path, '.git/hooks'))).toBe(true)
    expect(existsSync(join(repo.path, '.git/info'))).toBe(true)
    expect(await repo.git('config', '--local', 'user.name')).toBe('ADE E2E')
    expect(await repo.git('config', '--local', 'user.email')).toBe('e2e@example.invalid')
    expect(await repo.git('config', '--local', 'commit.gpgsign')).toBe('false')
    expect(existsSync(join(repo.path, '.git/objects/info/alternates'))).toBe(false)
  }
  const configs = await Promise.all(
    [template, ...[first, second].map((repo) => join(repo.path, '.git/config'))].map((file) => stat(file)),
  )
  expect(new Set(configs.map((value) => `${value.dev}:${value.ino}`)).size).toBe(3)

  const secondHead = await second.head()
  await first.git('config', 'user.name', 'Changed only here')
  const firstHead = await first.commit('Only in the first repository', { 'private.txt': 'private\n' })
  await first.write('staged.txt', 'staged only here\n')
  await first.git('add', 'staged.txt')
  expect(await first.status()).toEqual(['A  staged.txt'])
  expect(await second.status()).toEqual([])
  expect(await second.head()).toBe(secondHead)
  expect(await second.git('config', '--local', 'user.name')).toBe('ADE E2E')
  await expect(second.git('cat-file', '-e', firstHead)).rejects.toThrow()
  expect(await second.read('second.txt')).toBe('second\n')
  expect(await readFile(template, 'utf8')).toBe(original)
})
