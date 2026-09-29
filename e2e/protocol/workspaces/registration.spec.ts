// Workspace registration: Git and ordinary folders keep their identity across
// a daemon restart and through an alias, and a folder moved or replaced
// underneath is reported as needing a rebind instead of being silently
// adopted. Ported from the legacy e2e/specs/workspace-registration spec.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type AdeHarness } from '../fixtures'
import { scratchEnvironment } from '../fixtures/environment'

const run = promisify(execFile)

/** `git init` with no commit, as a user's brand-new checkout. */
async function emptyRepository(ade: AdeHarness, path: string): Promise<void> {
  await run('git', ['init', '-q', path], { cwd: ade.root, env: scratchEnvironment(join(ade.root, 'git-home')) })
}

test('Git and ordinary folders retain identity and report missing or replaced bindings', async ({ ade, profile }) => {
  const plain = join(ade.root, 'plain')
  const alias = join(ade.root, 'plain-alias')
  const checkout = join(ade.root, 'checkout')
  await mkdir(plain)
  await symlink(plain, alias)
  await emptyRepository(ade, checkout)
  await writeFile(join(checkout, 'marker'), 'original repository\n')

  const ordinary = (await profile.call('workspace.open', { path: plain })).workspace
  const repository = (await profile.call('workspace.open', { path: checkout })).workspace
  expect(ordinary.kind).toBe('folder')
  expect(repository.kind).toBe('primary_checkout')
  expect((await profile.call('workspace.open', { path: alias })).workspace).toMatchObject({
    id: ordinary.id,
    root: ordinary.root,
    needs_rebind: false,
  })

  await profile.restartDaemon()
  expect((await profile.call('workspace.open', { path: plain })).workspace).toMatchObject({
    id: ordinary.id,
    project_id: ordinary.project_id,
    needs_rebind: false,
  })
  expect((await profile.call('workspace.open', { path: checkout })).workspace).toMatchObject({
    id: repository.id,
    project_id: repository.project_id,
    needs_rebind: false,
  })

  // Replace the ordinary folder with an empty one, and move the checkout away.
  await rename(plain, join(ade.root, 'original-plain'))
  await mkdir(plain)
  await rename(checkout, join(ade.root, 'original-checkout'))
  const { catalog } = await profile.call('catalog.get', {})
  expect(catalog.workspaces.find((item) => item.id === ordinary.id)).toMatchObject({
    root: ordinary.root,
    needs_rebind: true,
  })
  expect(catalog.workspaces.find((item) => item.id === repository.id)).toMatchObject({
    root: repository.root,
    needs_rebind: true,
  })
  expect((await profile.call('workspace.rebind.list', {})).workspaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: ordinary.id, needs_rebind: true }),
      expect.objectContaining({ id: repository.id, needs_rebind: true }),
    ]),
  )
  expect((await profile.call('workspace.open', { path: plain })).workspace).toMatchObject({
    id: ordinary.id,
    needs_rebind: true,
  })
  await expect(profile.call('workspace.open', { path: checkout })).rejects.toThrow(/unavailable/i)
  const unrelated = join(ade.root, 'unrelated-checkout')
  await emptyRepository(ade, unrelated)
  await expect(profile.call('workspace.open', { path: unrelated })).rejects.toThrow(/needs_rebind/)
  await expect(profile.call('terminal.create', { workspace_id: ordinary.id })).rejects.toThrow(/needs_rebind/)
  const after = (await profile.call('catalog.get', {})).catalog
  expect(after.workspaces.filter((item) => item.id === ordinary.id || item.id === repository.id)).toHaveLength(2)
})

test('a slow catalog path probe does not hold the daemon state lock', async ({ ade }) => {
  const pause = join(ade.root, 'pause')
  await mkdir(pause)
  const profile = await ade.profile({ env: { ADE_E2E_CATALOG_PAUSE_DIR: pause, ADE_E2E_WORKER_PAUSE_ENABLED: '1' } })
  await writeFile(join(pause, 'armed'), '')
  const catalog = profile.call('catalog.get', {})
  await expect.poll(() => existsSync(join(pause, 'signal')), { timeout: 3_000 }).toBe(true)
  // The daemon still answers while the catalog's path probe is paused.
  expect((await profile.rpc({ op: 'hello' }, 1_000)).type).toBe('hello')
  await writeFile(join(pause, 'release'), '')
  expect((await catalog).type).toBe('catalog')
})
