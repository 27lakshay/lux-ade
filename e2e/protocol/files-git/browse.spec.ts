// F071: bounded file browse and search on the execution host, with cursors,
// path safety, permission failures and changed paths.
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { openWorkspace } from './steps'

type Entry = { name: string; path: string; kind: string; size: number | null }
type ListPage = { entries: Entry[]; next_cursor: string | null }
type SearchPage = { results: Entry[]; next_cursor: string | null; incomplete: boolean }

async function tree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

test('browses nested folders in bounded pages whose cursors are single-use and bound to their folder and workspace', async ({
  ade,
  profile,
}) => {
  const root = join(ade.root, 'browse')
  await tree(root, { 'src/lib/main.rs': 'fn main() {}\n', 'src/README.md': '# src\n', 'docs/guide.md': 'guide\n' })
  for (let index = 0; index < 230; index++)
    await writeFile(join(root, `entry-${String(index).padStart(3, '0')}.txt`), `${index}\n`)
  const other = join(ade.root, 'other')
  await tree(other, { 'a.txt': 'a\n' })
  const workspace_id = await openWorkspace(profile, root)
  const otherId = await openWorkspace(profile, other)

  // Three pages of at most 100 cover the root exactly once.
  const seen: Entry[] = []
  let cursor: string | null | undefined
  const cursors: string[] = []
  do {
    const page = await profile.call('file.list', { workspace_id, ...(cursor ? { cursor } : {}), limit: 100 })
    expect(page.entries.length).toBeLessThanOrEqual(100)
    expect(page.path).toBe('')
    seen.push(...(page.entries as Entry[]))
    cursor = page.next_cursor
    if (cursor) cursors.push(cursor)
  } while (cursor)
  expect(cursors).toHaveLength(2)
  const names = seen.map((entry) => entry.name)
  expect(new Set(names).size).toBe(names.length)
  expect(names).toHaveLength(232)
  expect(seen.find((entry) => entry.name === 'src')).toMatchObject({ kind: 'directory', size: null, path: 'src' })
  expect(seen.find((entry) => entry.name === 'entry-007.txt')).toMatchObject({ kind: 'file', size: 2 })

  // A used cursor is gone; a live one refuses another folder, operation or workspace.
  await expect(profile.call('file.list', { workspace_id, cursor: cursors[0] })).rejects.toThrow(
    /expired or was already used/,
  )
  const first = await profile.call('file.list', { workspace_id, limit: 10 })
  await expect(profile.call('file.list', { workspace_id, path: 'src', cursor: first.next_cursor! })).rejects.toThrow(
    /another file operation or target/,
  )
  const again = await profile.call('file.list', { workspace_id, limit: 10 })
  await expect(profile.call('file.list', { workspace_id: otherId, cursor: again.next_cursor! })).rejects.toThrow(
    /another workspace/,
  )
  const forged = await profile.call('file.list', { workspace_id, limit: 10 })
  await expect(
    profile.call('file.search', { workspace_id, query: 'entry', cursor: forged.next_cursor! }),
  ).rejects.toThrow(/another file operation or target/)
  await expect(profile.call('file.list', { workspace_id, cursor: 'not-a-cursor' })).rejects.toThrow(
    /Invalid file cursor/,
  )
  await expect(profile.call('file.list', { workspace_id, limit: 101 })).rejects.toThrow()
  await expect(profile.rpc({ op: 'file.list', workspace_id, limit: 0 })).rejects.toThrow(/page limit/)

  // Nested folders list their own entries with workspace-relative paths.
  const nested = await profile.call('file.list', { workspace_id, path: 'src/lib' })
  expect(nested).toMatchObject({ path: 'src/lib', next_cursor: null, incomplete: false })
  expect(nested.entries).toEqual([{ name: 'main.rs', path: 'src/lib/main.rs', kind: 'file', size: 13 }])

  // Search is case-insensitive over names at any depth, paged with its own cursors.
  const readme = await profile.call('file.search', { workspace_id, query: 'readme' })
  expect(readme.results.map((entry) => entry.path)).toEqual(['src/README.md'])
  const matches: string[] = []
  let searchCursor: string | null = null
  let pages = 0
  do {
    const page: SearchPage = await profile.call('file.search', {
      workspace_id,
      query: 'ENTRY-',
      limit: 100,
      ...(searchCursor ? { cursor: searchCursor } : {}),
    })
    expect(page.results.length).toBeLessThanOrEqual(100)
    matches.push(...page.results.map((entry) => entry.path))
    searchCursor = page.next_cursor
    pages++
  } while (searchCursor)
  expect(pages).toBeGreaterThanOrEqual(3)
  expect(new Set(matches).size).toBe(230)

  // The CLI drives the same commands.
  const listed = await profile.cli('file', 'list', workspace_id, 'src', '--limit', '1')
  expect(listed.code).toBe(0)
  expect(listed.json!.entries as Entry[]).toHaveLength(1)
  expect(listed.json!.next_cursor).toEqual(expect.any(String))
  const continued = await profile.cli(
    'file',
    'list',
    workspace_id,
    'src',
    '--cursor',
    listed.json!.next_cursor as string,
  )
  expect(continued.code).toBe(0)
  expect(
    [...(listed.json!.entries as Entry[]), ...(continued.json!.entries as Entry[])].map((entry) => entry.name).sort(),
  ).toEqual(['README.md', 'lib'])
  const searched = await profile.cli('file', 'search', workspace_id, 'guide')
  expect(searched.code).toBe(0)
  expect(searched.json!.results).toEqual([{ name: 'guide.md', path: 'docs/guide.md', kind: 'file', size: 6 }])
  const refused = await profile.cli('file', 'list', workspace_id, '../other')
  expect(refused.code).not.toBe(0)
})

test('never leaves the workspace through parent paths, absolute paths or symbolic links', async ({ ade, profile }) => {
  const root = join(ade.root, 'safe')
  const secretDir = join(ade.root, 'secret')
  await tree(root, { 'inside/notes.txt': 'notes\n' })
  await tree(secretDir, { 'key.txt': 'outside secret\n' })
  await symlink(join(secretDir, 'key.txt'), join(root, 'file-link'))
  await symlink(secretDir, join(root, 'dir-link'))
  await symlink('inside', join(root, 'inner-link'))
  const workspace_id = await openWorkspace(profile, root)

  const top = await profile.call('file.list', { workspace_id })
  const kinds = Object.fromEntries(top.entries.map((entry) => [entry.name, entry.kind]))
  expect(kinds).toEqual({ inside: 'directory', 'file-link': 'symlink', 'dir-link': 'symlink', 'inner-link': 'symlink' })
  for (const entry of top.entries) if (entry.kind === 'symlink') expect(entry.size).toBeNull()

  for (const path of ['..', '../secret', 'inside/../../secret', secretDir, '/etc']) {
    await expect(profile.call('file.list', { workspace_id, path }), path).rejects.toThrow(
      /relative without parent traversal/,
    )
  }
  for (const path of ['../secret/key.txt', `${secretDir}/key.txt`]) {
    await expect(profile.call('file.preview', { workspace_id, path }), path).rejects.toThrow(
      /relative without parent traversal/,
    )
  }
  // Links are listed, never followed, even when they point inside the workspace.
  for (const path of ['dir-link', 'inner-link', 'dir-link/key.txt']) {
    await expect(profile.call('file.list', { workspace_id, path }), path).rejects.toThrow()
  }
  for (const path of ['file-link', 'dir-link/key.txt', 'inner-link/notes.txt']) {
    await expect(profile.call('file.preview', { workspace_id, path }), path).rejects.toThrow()
  }
  // A private-use encoded name cannot smuggle a parent component.
  await expect(profile.call('file.preview', { workspace_id, path: 'Li4/secret/key.txt' })).rejects.toThrow()
  // Search reports the links but does not descend through them.
  const found = await profile.call('file.search', { workspace_id, query: 'key' })
  expect(found.results).toEqual([])
  const links = await profile.call('file.search', { workspace_id, query: 'link' })
  expect(links.results.map((entry) => entry.path).sort()).toEqual(['dir-link', 'file-link', 'inner-link'])
  expect(await readFile(join(secretDir, 'key.txt'), 'utf8')).toBe('outside secret\n')
})

test('a large tree lists and searches past the scan budgets, and an unreadable folder is refused or skipped', async ({
  ade,
  profile,
}) => {
  const root = join(ade.root, 'large')
  await mkdir(join(root, 'wide'), { recursive: true })
  for (let batch = 0; batch < 10_050; batch += 150) {
    await Promise.all(
      Array.from({ length: Math.min(150, 10_050 - batch) }, (_, offset) =>
        writeFile(join(root, 'wide', `n${batch + offset}`), ''),
      ),
    )
  }
  await tree(root, {
    'zz-deep/target-match.txt': 'found\n',
    'locked/hidden-match.txt': 'hidden\n',
    'open/visible-match.txt': 'x\n',
  })
  const workspace_id = await openWorkspace(profile, root)

  // Listing continues beyond one request's 10,000-name budget.
  let total = 0
  let cursor: string | null = null
  let pages = 0
  do {
    const page: ListPage = await profile.call('file.list', {
      workspace_id,
      path: 'wide',
      ...(cursor ? { cursor } : {}),
    })
    expect(page.entries.length).toBeLessThanOrEqual(100)
    total += page.entries.length
    cursor = page.next_cursor
    pages++
  } while (cursor)
  expect(total).toBe(10_050)
  expect(pages).toBeGreaterThan(100)

  // Search over more than 1,000 non-matching names returns bounded pages
  // (possibly empty) with a cursor until it reaches the match.
  const found: string[] = []
  let searchCursor: string | null = null
  let searchPages = 0
  do {
    const page: SearchPage = await profile.call('file.search', {
      workspace_id,
      query: 'target-match',
      ...(searchCursor ? { cursor: searchCursor } : {}),
    })
    found.push(...page.results.map((entry) => entry.path))
    searchCursor = page.next_cursor
    searchPages++
  } while (searchCursor)
  expect(found).toEqual(['zz-deep/target-match.txt'])
  expect(searchPages).toBeGreaterThan(10)

  // The host refuses an unreadable folder: listing it fails, and search skips it
  // but still finds everything else and says the result is incomplete.
  await chmod(join(root, 'locked'), 0o000)
  try {
    await expect(profile.call('file.list', { workspace_id, path: 'locked' })).rejects.toThrow(
      /Permission denied|denied/i,
    )
    const partial: string[] = []
    let incomplete = false
    let next: string | null = null
    do {
      const page: SearchPage = await profile.call('file.search', {
        workspace_id,
        query: '-match',
        ...(next ? { cursor: next } : {}),
      })
      partial.push(...page.results.map((entry) => entry.path))
      incomplete ||= page.incomplete
      next = page.next_cursor
    } while (next)
    expect(partial.sort()).toEqual(['open/visible-match.txt', 'zz-deep/target-match.txt'])
    expect(incomplete).toBe(true)
  } finally {
    await chmod(join(root, 'locked'), 0o755)
  }
})

test('changed paths invalidate cursors, a daemon restart drops them, and a replaced root needs a rebind', async ({
  ade,
  profile,
}) => {
  const root = join(ade.root, 'changing')
  await tree(root, { 'dir/a.txt': 'a\n' })
  for (let index = 0; index < 30; index++) await writeFile(join(root, 'dir', `f${index}.txt`), '')
  const workspace_id = await openWorkspace(profile, root)

  // A folder that changes between pages is reported, never silently mixed.
  const first = await profile.call('file.list', { workspace_id, path: 'dir', limit: 5 })
  await writeFile(join(root, 'dir', 'new.txt'), 'new\n')
  await expect(profile.call('file.list', { workspace_id, path: 'dir', cursor: first.next_cursor! })).rejects.toThrow(
    /changed; refresh/,
  )

  // A folder renamed away mid-search fails the continuation.
  await tree(root, { 'moving/sub/f.txt': 'f\n' })
  for (let index = 0; index < 20; index++) await writeFile(join(root, 'moving', `m${index}.txt`), '')
  const search = await profile.call('file.search', { workspace_id, query: 'm', limit: 1 })
  expect(search.next_cursor).toEqual(expect.any(String))
  await rename(join(root, 'moving'), join(root, 'moved'))
  await expect(
    profile.call('file.search', { workspace_id, query: 'm', limit: 1, cursor: search.next_cursor! }),
  ).rejects.toThrow(/changed|refresh|No such file/)

  // A preview of a path that vanished fails cleanly.
  await rm(join(root, 'dir', 'a.txt'))
  await expect(profile.call('file.preview', { workspace_id, path: 'dir/a.txt' })).rejects.toThrow(/No such file/)

  // Cursors live in the daemon; a restart invalidates them instead of resuming a stale scan.
  const live = await profile.call('file.list', { workspace_id, path: 'dir', limit: 5 })
  await profile.restartDaemon('kill')
  await expect(profile.call('file.list', { workspace_id, path: 'dir', cursor: live.next_cursor! })).rejects.toThrow(
    /expired/,
  )
  expect((await profile.call('file.list', { workspace_id, path: 'dir', limit: 100 })).entries.length).toBe(31)

  // A different folder installed at the workspace path is not the workspace.
  await rename(root, `${root}-old`)
  await mkdir(root)
  await writeFile(join(root, 'impostor.txt'), 'unrelated\n')
  await expect(profile.call('file.list', { workspace_id })).rejects.toThrow(/needs_rebind|rebind/i)
  await expect(profile.call('file.search', { workspace_id, query: 'impostor' })).rejects.toThrow(/needs_rebind|rebind/i)
  await expect(profile.call('file.preview', { workspace_id, path: 'impostor.txt' })).rejects.toThrow(
    /needs_rebind|rebind/i,
  )
})
