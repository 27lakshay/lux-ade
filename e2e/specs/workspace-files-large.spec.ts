import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

type FileEntry = { name: string; path: string; kind: string }
type FilePage = {
  entries?: FileEntry[]
  results?: FileEntry[]
  next_cursor?: string | null
  incomplete?: boolean
}
const execFileAsync = promisify(execFile)

async function createFiles(directory: string, count: number, prefix: string): Promise<void> {
  // Bound open file descriptors while keeping the large-tree fixture quick.
  for (let start = 0; start < count; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - start) }, (_, offset) =>
      writeFile(join(directory, `${prefix}-${String(start + offset).padStart(5, '0')}.txt`), 'x')))
  }
}

test('F071 lists more than 10,000 entries across pages and rejects a changed directory cursor', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'ade-files-large-list-'))
  const expectedCount = 10_025
  await createFiles(root, expectedCount, 'entry')
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const request = { op: 'file.list', workspace_id: workspace.id, limit: 100 }
    const first = await rpc(daemon.socket, request, 20_000) as FilePage
    expect(first.entries).toHaveLength(100)
    expect(first.next_cursor, 'A full first page must have an accessible continuation').toEqual(expect.any(String))

    const changed = join(root, 'new-during-listing.txt')
    await writeFile(changed, 'new')
    await expect(rpc(daemon.socket, { ...request, cursor: first.next_cursor }, 20_000))
      .rejects.toThrow(/changed|stale|refresh/i)
    await unlink(changed)

    const seen = new Set<string>()
    let cursor: string | null | undefined
    let pages = 0
    do {
      const page = await rpc(daemon.socket, cursor ? { ...request, cursor } : request, 20_000) as FilePage
      for (const entry of page.entries ?? []) {
        expect(seen.has(entry.path), `Duplicate file in page ${pages}: ${entry.path}`).toBe(false)
        seen.add(entry.path)
      }
      cursor = page.next_cursor
      if (!cursor) expect(page.incomplete, 'The final listing page must confirm completion').toBe(false)
      pages++
      expect(pages, 'Listing did not terminate').toBeLessThan(150)
    } while (cursor)
    expect(seen.size, 'Listing omitted entries after its scan budget').toBe(expectedCount)
    expect(seen.has('entry-10024.txt')).toBe(true)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('F071 searches more than 1,000 matches without repeats or omissions and rejects nested mutation', async () => {
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'ade-files-large-search-'))
  const nested = join(root, 'nested')
  await mkdir(nested)
  const expectedCount = 1_225
  await createFiles(nested, expectedCount, 'needle')
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const request = { op: 'file.search', workspace_id: workspace.id, query: 'needle', limit: 100 }
    const first = await rpc(daemon.socket, request, 20_000) as FilePage
    expect(first.results).toHaveLength(100)
    expect(first.next_cursor, 'A full search page must have an accessible continuation').toEqual(expect.any(String))

    const changed = join(nested, 'needle-new.txt')
    await writeFile(changed, 'new')
    await expect(rpc(daemon.socket, { ...request, cursor: first.next_cursor }, 20_000))
      .rejects.toThrow(/changed|stale|refresh/i)
    await unlink(changed)

    const seen = new Set<string>()
    let cursor: string | null | undefined
    let pages = 0
    do {
      const page = await rpc(daemon.socket, cursor ? { ...request, cursor } : request, 20_000) as FilePage
      for (const entry of page.results ?? []) {
        expect(seen.has(entry.path), `Duplicate search result in page ${pages}: ${entry.path}`).toBe(false)
        seen.add(entry.path)
      }
      cursor = page.next_cursor
      if (!cursor) expect(page.incomplete, 'The final search page must confirm completion').toBe(false)
      pages++
      expect(pages, 'Search did not terminate').toBeLessThan(30)
    } while (cursor)
    expect(seen.size, 'Search omitted results after its scan budget').toBe(expectedCount)
    expect(seen.has('nested/needle-01224.txt')).toBe(true)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('F071 continues a no-match search after scanning 1,000 names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-files-search-budget-'))
  await createFiles(root, 1_125, 'padding')
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const request = { op: 'file.search', workspace_id: workspace.id, query: 'absent-name', limit: 100 }
    const first = await rpc(daemon.socket, request) as FilePage
    expect(first.results).toEqual([])
    expect(first.next_cursor).toEqual(expect.any(String))
    const second = await rpc(daemon.socket, { ...request, cursor: first.next_cursor }) as FilePage
    expect(second.results).toEqual([])
    expect(second.next_cursor).toBeNull()
    expect(second.incomplete).toBe(false)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('F071 idle cursors release their directory descriptors after expiry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-files-cursor-expiry-'))
  await createFiles(root, 120, 'entry')
  const daemon = await startDaemon({ ADE_E2E_FILE_SCAN_TTL_MS: '100' })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    for (let index = 0; index < 3; index++) {
      const page = await rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id, limit: 1 }) as FilePage
      expect(page.next_cursor).toEqual(expect.any(String))
    }
    const canonicalRoot = await realpath(root)
    const openCount = async (): Promise<number> => {
      const { stdout } = await execFileAsync('lsof', ['-p', String(daemon.hello.pid), '-Fn'])
      return stdout.split('\n').filter((line) => line === `n${canonicalRoot}`).length
    }
    expect(await openCount()).toBeGreaterThanOrEqual(3)
    await delay(400)
    expect(await openCount()).toBe(0)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('F071 can browse and preview a non-UTF-8 file name alongside ordinary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-files-bytes-'))
  try {
    await writeFile(join(root, 'normal.txt'), 'normal')
    const bytePath = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff]), Buffer.from('.txt')])
    try {
      await writeFile(bytePath, 'byte-name')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EILSEQ') {
        test.skip(true, 'The host filesystem rejects non-UTF-8 file names')
      }
      throw error
    }
    const daemon = await startDaemon()
    try {
      const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: root })).workspace as { id: string }
      const page = await rpc(daemon.socket, { op: 'file.list', workspace_id: workspace.id }) as FilePage
      expect(page.entries).toHaveLength(2)
      const unusual = page.entries?.find((entry) => entry.name !== 'normal.txt')
      expect(unusual?.path).toEqual(expect.any(String))
      const preview = await rpc(daemon.socket, { op: 'file.preview', workspace_id: workspace.id, path: unusual?.path })
      expect(preview).toMatchObject({ kind: 'text', text: 'byte-name' })
    } finally {
      await daemon.stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('F071 continuation cursors can be consumed only once, even by concurrent requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-files-cursor-once-'))
  await createFiles(root, 5, 'entry')
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const request = { op: 'file.list', workspace_id: workspace.id, limit: 1 }
    const first = await rpc(daemon.socket, request) as FilePage
    expect(first.next_cursor).toEqual(expect.any(String))
    const second = await rpc(daemon.socket, { ...request, cursor: first.next_cursor }) as FilePage
    expect(second.entries).toHaveLength(1)
    await expect(rpc(daemon.socket, { ...request, cursor: first.next_cursor }))
      .rejects.toThrow(/expired|used|cursor/i)

    const newFirst = await rpc(daemon.socket, request) as FilePage
    expect(newFirst.next_cursor).toEqual(expect.any(String))
    const attempts = await Promise.allSettled([
      rpc(daemon.socket, { ...request, cursor: newFirst.next_cursor }),
      rpc(daemon.socket, { ...request, cursor: newFirst.next_cursor }),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('F071 a cursor rejected in another workspace remains usable in its owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-files-cursor-owner-'))
  const firstRoot = join(root, 'first')
  const otherRoot = join(root, 'other')
  await mkdir(firstRoot)
  await mkdir(otherRoot)
  await createFiles(firstRoot, 5, 'first')
  await createFiles(otherRoot, 5, 'other')
  const daemon = await startDaemon()
  try {
    const first = (await rpc(daemon.socket, { op: 'workspace.open', path: firstRoot })).workspace as { id: string }
    const other = (await rpc(daemon.socket, { op: 'workspace.open', path: otherRoot })).workspace as { id: string }
    const request = { op: 'file.list', workspace_id: first.id, limit: 1 }
    const firstPage = await rpc(daemon.socket, request) as FilePage
    expect(firstPage.next_cursor).toEqual(expect.any(String))
    await expect(rpc(daemon.socket, { ...request, workspace_id: other.id, cursor: firstPage.next_cursor }))
      .rejects.toThrow(/workspace|cursor/i)
    const secondPage = await rpc(daemon.socket, { ...request, cursor: firstPage.next_cursor }) as FilePage
    expect(secondPage.entries).toHaveLength(1)
    expect(secondPage.entries?.[0]?.path).toMatch(/^first-/)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('F071 scan capacity evicts an old cursor and preserves the most recent scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-files-cursor-limit-'))
  await createFiles(root, 3, 'entry')
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const request = { op: 'file.list', workspace_id: workspace.id, limit: 1 }
    const cursors: string[] = []
    for (let index = 0; index < 9; index++) {
      const first = await rpc(daemon.socket, request) as FilePage
      expect(first.next_cursor).toEqual(expect.any(String))
      cursors.push(first.next_cursor as string)
    }
    await expect(rpc(daemon.socket, { ...request, cursor: cursors[0] }))
      .rejects.toThrow(/expired|used|cursor/i)
    const newest = await rpc(daemon.socket, { ...request, cursor: cursors.at(-1) }) as FilePage
    expect(newest.entries).toHaveLength(1)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('F071 search detects changes in a folder already visited before a later page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-files-search-snapshot-'))
  for (const name of ['alpha', 'beta']) {
    const directory = join(root, name)
    await mkdir(directory)
    await createFiles(directory, 3, 'needle')
  }
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: root })).workspace as { id: string }
    const request = { op: 'file.search', workspace_id: workspace.id, query: 'needle', limit: 1 }
    let cursor: string | null | undefined
    let firstFolder: string | undefined
    let sawSecondFolder = false
    for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
      const page = await rpc(daemon.socket, cursor ? { ...request, cursor } : request) as FilePage
      const folder = page.results?.[0]?.path.split('/')[0]
      if (!firstFolder) firstFolder = folder
      cursor = page.next_cursor
      if (folder && folder !== firstFolder) {
        sawSecondFolder = true
        break
      }
    }
    expect(firstFolder).toEqual(expect.any(String))
    expect(sawSecondFolder, 'Search never moved past the first folder').toBe(true)
    expect(cursor).toEqual(expect.any(String))
    await writeFile(join(root, firstFolder as string, 'needle-late.txt'), 'new')
    await expect(rpc(daemon.socket, { ...request, cursor }))
      .rejects.toThrow(/changed|stale|refresh/i)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})
