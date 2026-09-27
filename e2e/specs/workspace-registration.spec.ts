import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)
type Workspace = { id: string; root: string; repository_id: string | null; needs_rebind: boolean }

test('Git and ordinary folders retain identity and report missing or replaced bindings', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'ade-workspace-registration-'))
  const plain = join(fixture, 'plain')
  const checkout = join(fixture, 'checkout')
  const alias = join(fixture, 'plain-alias')
  const data = join(fixture, 'profile-data')
  await mkdir(plain)
  await symlink(plain, alias)
  await run('git', ['init', '-q', checkout])
  await writeFile(join(checkout, 'marker'), 'original repository\n')
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null
  try {
    daemon = await startDaemon({ ADE_DATA_DIR: data })
    const ordinary = (await rpc(daemon.socket, { op: 'workspace.open', path: plain })).workspace as Workspace
    const repository = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as Workspace
    expect(ordinary.repository_id).toBeNull()
    expect(repository.repository_id).toEqual(expect.any(String))
    expect((await rpc(daemon.socket, { op: 'workspace.open', path: alias })).workspace).toMatchObject({
      id: ordinary.id,
      root: ordinary.root,
      needs_rebind: false,
    })
    await daemon.stop()
    daemon = null

    daemon = await startDaemon({ ADE_DATA_DIR: data })
    expect((await rpc(daemon.socket, { op: 'workspace.open', path: plain })).workspace).toMatchObject({
      id: ordinary.id,
      repository_id: null,
      needs_rebind: false,
    })
    expect((await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace).toMatchObject({
      id: repository.id,
      repository_id: repository.repository_id,
      needs_rebind: false,
    })

    await rename(plain, join(fixture, 'original-plain'))
    await mkdir(plain)
    await rename(checkout, join(fixture, 'original-checkout'))
    const catalog = (await rpc(daemon.socket, { op: 'catalog.get' })).catalog as { workspaces: Workspace[] }
    expect(catalog.workspaces.find((item) => item.id === ordinary.id)).toMatchObject({
      root: ordinary.root,
      needs_rebind: true,
    })
    expect(catalog.workspaces.find((item) => item.id === repository.id)).toMatchObject({
      root: repository.root,
      needs_rebind: true,
    })
    expect((await rpc(daemon.socket, { op: 'workspace.rebind.list' })).workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ordinary.id, needs_rebind: true }),
        expect.objectContaining({ id: repository.id, needs_rebind: true }),
      ]),
    )
    expect((await rpc(daemon.socket, { op: 'workspace.open', path: plain })).workspace).toMatchObject({
      id: ordinary.id,
      needs_rebind: true,
    })
    await expect(rpc(daemon.socket, { op: 'workspace.open', path: checkout })).rejects.toThrow(/unavailable/i)
    const unrelated = join(fixture, 'unrelated-checkout')
    await run('git', ['init', '-q', unrelated])
    await expect(rpc(daemon.socket, { op: 'workspace.open', path: unrelated })).rejects.toThrow(/needs_rebind/)
    await expect(rpc(daemon.socket, { op: 'terminal.create', workspace_id: ordinary.id })).rejects.toThrow(
      /needs_rebind/,
    )
    const after = (await rpc(daemon.socket, { op: 'catalog.get' })).catalog as { workspaces: Workspace[] }
    expect(after.workspaces.filter((item) => item.id === ordinary.id || item.id === repository.id)).toHaveLength(2)
  } finally {
    await daemon?.stop()
    await rm(fixture, { recursive: true, force: true })
  }
})

test('a slow catalog path probe does not hold the daemon state lock', async () => {
  const pause = await mkdtemp(join(tmpdir(), 'ade-catalog-pause-'))
  const daemon = await startDaemon({ ADE_E2E_CATALOG_PAUSE_DIR: pause, ADE_E2E_WORKER_PAUSE_ENABLED: '1' })
  try {
    await writeFile(join(pause, 'armed'), '')
    const catalog = rpc(daemon.socket, { op: 'catalog.get' })
    await expect
      .poll(
        () =>
          stat(join(pause, 'signal')).then(
            () => true,
            () => false,
          ),
        { timeout: 3_000 },
      )
      .toBe(true)
    expect((await rpc(daemon.socket, { op: 'hello' }, 1_000)).type).toBe('hello')
    await writeFile(join(pause, 'release'), '')
    expect((await catalog).type).toBe('catalog')
  } finally {
    await writeFile(join(pause, 'release'), '').catch(() => undefined)
    await daemon.stop()
    await rm(pause, { recursive: true, force: true })
  }
})
