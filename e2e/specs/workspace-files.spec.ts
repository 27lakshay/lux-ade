import { expect, test } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rpc, startDaemon } from '../fixtures/daemon'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')

test('workspace file commands browse, search and preview without following outside symlinks', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'ade-files-e2e-'))
  const workspaceRoot = join(outside, 'workspace')
  const secret = join(outside, 'outside-secret.txt')
  await mkdir(join(workspaceRoot, 'nested'), { recursive: true })
  await writeFile(join(workspaceRoot, 'nested', 'notes.txt'), 'Alpha from the workspace\n')
  await writeFile(join(workspaceRoot, 'pixel.png'), png)
  await writeFile(join(workspaceRoot, 'page.html'), '<script>window.adeHost</script>')
  await writeFile(join(workspaceRoot, 'huge.txt'), 'x'.repeat(300 * 1024))
  await writeFile(secret, 'private outside workspace\n')
  await symlink(secret, join(workspaceRoot, 'nested', 'outside-link'))
  for (let index = 0; index < 110; index++) {
    await writeFile(join(workspaceRoot, `entry-${String(index).padStart(3, '0')}.txt`), `${index}\n`)
  }
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: workspaceRoot }))
      .workspace as { id: string }
    const first = await rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id, limit: 50 })
    expect(first).toMatchObject({ type: 'file_list', path: '' })
    expect((first.entries as unknown[]).length).toBeLessThanOrEqual(50)
    expect(first.next_cursor).toEqual(expect.any(String))
    const second = await rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id,
      cursor: first.next_cursor, limit: 50 })
    expect((second.entries as unknown[]).length).toBeLessThanOrEqual(50)
    const names = [...(first.entries as Array<{ name: string }>),
      ...(second.entries as Array<{ name: string }>)].map((item) => item.name)
    expect(new Set(names).size).toBe(names.length)
    const third = await rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id,
      cursor: second.next_cursor, limit: 50 })
    expect((third.entries as unknown[]).length).toBeGreaterThan(0)
    const nested = await rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id, path: 'nested' })
    expect(nested.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'notes.txt', path: 'nested/notes.txt', kind: 'file' }),
    ]))
    const found = await rpc(daemon.socket, { op: 'file.search', workspace_id: workspace.id, query: 'notes' })
    expect(found.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nested/notes.txt', kind: 'file' }),
    ]))
    const searchPage = await rpc(daemon.socket, { op: 'file.search', workspace_id: workspace.id,
      query: 'entry-', limit: 20 })
    expect((searchPage.results as unknown[]).length).toBeLessThanOrEqual(20)
    expect(searchPage.next_cursor).toEqual(expect.any(String))
    const moreMatches = await rpc(daemon.socket, { op: 'file.search', workspace_id: workspace.id,
      query: 'entry-', limit: 20, cursor: searchPage.next_cursor })
    const firstPaths = new Set((searchPage.results as Array<{ path: string }>).map((item) => item.path))
    expect((moreMatches.results as Array<{ path: string }>).every((item) => !firstPaths.has(item.path))).toBe(true)
    const text = await rpc(daemon.socket, { op: 'file.preview', workspace_id: workspace.id,
      path: 'nested/notes.txt' })
    expect(text).toMatchObject({ type: 'file_preview', kind: 'text', text: 'Alpha from the workspace\n',
      truncated: false })
    const image = await rpc(daemon.socket, { op: 'file.preview', workspace_id: workspace.id,
      path: 'pixel.png' })
    expect(image).toMatchObject({ kind: 'image', mime: 'image/png', bytes_base64: png.toString('base64') })
    const html = await rpc(daemon.socket, { op: 'file.preview', workspace_id: workspace.id,
      path: 'page.html' })
    expect(html.kind).toBe('unsupported')
    expect(JSON.stringify(html)).not.toContain('window.adeHost')
    const huge = await rpc(daemon.socket, { op: 'file.preview', workspace_id: workspace.id,
      path: 'huge.txt' })
    expect(huge.kind === 'unsupported' || huge.truncated === true).toBe(true)
    expect(JSON.stringify(huge).length).toBeLessThan(400_000)
    const linked = await rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id,
      path: 'nested' })
    expect(linked.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'outside-link', kind: 'symlink' }),
    ]))
    await expect(rpc(daemon.socket, { op: 'file.preview', workspace_id: workspace.id,
      path: 'nested/outside-link' })).rejects.toThrow()
    await expect(rpc(daemon.socket, { op: 'file.preview', workspace_id: workspace.id,
      path: '../outside-secret.txt' })).rejects.toThrow()
    expect(await readFile(secret, 'utf8')).toBe('private outside workspace\n')

    await mkdir(join(workspaceRoot, 'locked'))
    await chmod(join(workspaceRoot, 'locked'), 0o000)
    await expect(rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id,
      path: 'locked' })).rejects.toThrow()
    await chmod(join(workspaceRoot, 'locked'), 0o700)
    const moved = join(outside, 'moved-workspace')
    await rename(workspaceRoot, moved)
    await mkdir(workspaceRoot)
    await writeFile(join(workspaceRoot, 'replacement.txt'), 'unrelated checkout')
    await expect(rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id }))
      .rejects.toThrow(/needs_rebind/)

  } finally {
    await daemon.stop()
    await rm(outside, { recursive: true, force: true })
  }
})
