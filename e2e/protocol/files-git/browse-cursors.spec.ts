// F071 cursor edges: large search result sets, cursor expiry and capacity,
// concurrent and cross-workspace use, non-UTF-8 names, and a folder changed
// after search already visited it. Ported from the legacy
// e2e/specs/workspace-files-large spec; its 10,000-entry listing and its
// no-match search budget are covered by browse.spec.ts.
import { execFile } from 'node:child_process'
import { mkdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '../fixtures'
import { openWorkspace } from './steps'

const run = promisify(execFile)

type Entry = { name: string; path: string; kind: string }

async function createFiles(directory: string, count: number, prefix: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  // Bound open file descriptors while keeping the fixture quick.
  for (let start = 0; start < count; start += 64) {
    await Promise.all(
      Array.from({ length: Math.min(64, count - start) }, (_, offset) =>
        writeFile(join(directory, `${prefix}-${String(start + offset).padStart(5, '0')}.txt`), 'x'),
      ),
    )
  }
}

test('F071 searches more than 1,000 matches without repeats or omissions and rejects nested mutation', async ({
  ade,
  profile,
}) => {
  const root = join(ade.root, 'tree')
  const expectedCount = 1_225
  await createFiles(join(root, 'nested'), expectedCount, 'needle')
  const workspace_id = await openWorkspace(profile, root)
  const request = { workspace_id, query: 'needle', limit: 100 }
  const first = await profile.call('file.search', request, { timeoutMs: 20_000 })
  expect(first.results).toHaveLength(100)
  expect(first.next_cursor, 'A full search page must have an accessible continuation').toEqual(expect.any(String))

  const changed = join(root, 'nested', 'needle-new.txt')
  await writeFile(changed, 'new')
  await expect(
    profile.call('file.search', { ...request, cursor: first.next_cursor! }, { timeoutMs: 20_000 }),
  ).rejects.toThrow(/changed|stale|refresh/i)
  await unlink(changed)

  const seen = new Set<string>()
  let cursor: string | null = null
  let pages = 0
  do {
    const page: { results: Entry[]; next_cursor: string | null; incomplete: boolean } = await profile.call(
      'file.search',
      cursor ? { ...request, cursor } : request,
      { timeoutMs: 20_000 },
    )
    for (const entry of page.results) {
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
})

test('F071 idle cursors release their directory descriptors after expiry', async ({ ade }) => {
  const profile = await ade.profile({ env: { ADE_E2E_FILE_SCAN_TTL_MS: '100' } })
  const root = join(ade.root, 'tree')
  await createFiles(root, 120, 'entry')
  const workspace_id = await openWorkspace(profile, root)
  for (let index = 0; index < 3; index++) {
    const page = await profile.call('file.list', { workspace_id, limit: 1 })
    expect(page.next_cursor).toEqual(expect.any(String))
  }
  const canonicalRoot = await realpath(root)
  const openCount = async (): Promise<number> => {
    const { stdout } = await run('lsof', ['-p', String(profile.hello.pid), '-Fn'])
    return stdout.split('\n').filter((line) => line === `n${canonicalRoot}`).length
  }
  expect(await openCount()).toBeGreaterThanOrEqual(3)
  await expect.poll(openCount, { timeout: 5_000 }).toBe(0)
})

test('F071 can browse and preview a non-UTF-8 file name alongside ordinary files', async ({ ade, profile }) => {
  const root = join(ade.root, 'bytes')
  await mkdir(root)
  await writeFile(join(root, 'normal.txt'), 'normal')
  const bytePath = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff]), Buffer.from('.txt')])
  try {
    await writeFile(bytePath, 'byte-name')
  } catch (error) {
    test.skip((error as NodeJS.ErrnoException).code === 'EILSEQ', 'The host filesystem rejects non-UTF-8 file names')
    throw error
  }
  const workspace_id = await openWorkspace(profile, root)
  const page = await profile.call('file.list', { workspace_id })
  expect(page.entries).toHaveLength(2)
  const unusual = page.entries.find((entry) => entry.name !== 'normal.txt')
  expect(unusual?.path).toEqual(expect.any(String))
  expect(await profile.call('file.preview', { workspace_id, path: unusual!.path })).toMatchObject({
    kind: 'text',
    text: 'byte-name',
  })
})

test('F071 continuation cursors can be consumed only once, even by concurrent requests', async ({ ade, profile }) => {
  const root = join(ade.root, 'tree')
  await createFiles(root, 5, 'entry')
  const workspace_id = await openWorkspace(profile, root)
  const request = { workspace_id, limit: 1 }
  const first = await profile.call('file.list', request)
  expect(first.next_cursor).toEqual(expect.any(String))
  const second = await profile.call('file.list', { ...request, cursor: first.next_cursor! })
  expect(second.entries).toHaveLength(1)
  await expect(profile.call('file.list', { ...request, cursor: first.next_cursor! })).rejects.toThrow(
    /expired|used|cursor/i,
  )

  const newFirst = await profile.call('file.list', request)
  expect(newFirst.next_cursor).toEqual(expect.any(String))
  const attempts = await Promise.allSettled([
    profile.call('file.list', { ...request, cursor: newFirst.next_cursor! }),
    profile.call('file.list', { ...request, cursor: newFirst.next_cursor! }),
  ])
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
  expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
})

test('F071 a cursor rejected in another workspace remains usable in its owner', async ({ ade, profile }) => {
  await createFiles(join(ade.root, 'first'), 5, 'first')
  await createFiles(join(ade.root, 'other'), 5, 'other')
  const first = await openWorkspace(profile, join(ade.root, 'first'))
  const other = await openWorkspace(profile, join(ade.root, 'other'))
  const request = { workspace_id: first, limit: 1 }
  const firstPage = await profile.call('file.list', request)
  expect(firstPage.next_cursor).toEqual(expect.any(String))
  await expect(
    profile.call('file.list', { ...request, workspace_id: other, cursor: firstPage.next_cursor! }),
  ).rejects.toThrow(/workspace|cursor/i)
  const secondPage = await profile.call('file.list', { ...request, cursor: firstPage.next_cursor! })
  expect(secondPage.entries).toHaveLength(1)
  expect(secondPage.entries[0]?.path).toMatch(/^first-/)
})

test('F071 scan capacity evicts an old cursor and preserves the most recent scan', async ({ ade, profile }) => {
  const root = join(ade.root, 'tree')
  await createFiles(root, 3, 'entry')
  const workspace_id = await openWorkspace(profile, root)
  const request = { workspace_id, limit: 1 }
  const cursors: string[] = []
  for (let index = 0; index < 9; index++) {
    const first = await profile.call('file.list', request)
    expect(first.next_cursor).toEqual(expect.any(String))
    cursors.push(first.next_cursor!)
  }
  await expect(profile.call('file.list', { ...request, cursor: cursors[0] })).rejects.toThrow(/expired|used|cursor/i)
  const newest = await profile.call('file.list', { ...request, cursor: cursors.at(-1)! })
  expect(newest.entries).toHaveLength(1)
})

test('F071 search detects changes in a folder already visited before a later page', async ({ ade, profile }) => {
  const root = join(ade.root, 'tree')
  for (const name of ['alpha', 'beta']) await createFiles(join(root, name), 3, 'needle')
  const workspace_id = await openWorkspace(profile, root)
  const request = { workspace_id, query: 'needle', limit: 1 }
  let cursor: string | null = null
  let firstFolder: string | undefined
  let sawSecondFolder = false
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    const page: { results: Entry[]; next_cursor: string | null } = await profile.call(
      'file.search',
      cursor ? { ...request, cursor } : request,
    )
    const folder = page.results[0]?.path.split('/')[0]
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
  await writeFile(join(root, firstFolder!, 'needle-late.txt'), 'new')
  await expect(profile.call('file.search', { ...request, cursor: cursor! })).rejects.toThrow(/changed|stale|refresh/i)
})
