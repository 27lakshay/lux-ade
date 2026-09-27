import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)

type DiffPage = {
  type: 'review_diff_page'
  revision: string
  token: string
  path: string
  staged: boolean
  rows: Array<{ kind: string; new_line: number | null; text: string; hunk: string; truncated: boolean }>
  next_cursor: string | null
  complete: boolean
  bytes: number
}

test('large diff pages expose later lines and reject a changed revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-review-page-'))
  const checkout = join(directory, 'checkout')
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await run('git', ['-C', checkout, 'add', 'tracked.txt'])
  await run('git', [
    '-C',
    checkout,
    '-c',
    'user.name=ADE Test',
    '-c',
    'user.email=ade@example.test',
    'commit',
    '-qm',
    'baseline',
  ])
  await writeFile(join(checkout, 'tracked.txt'), `baseline\n${'large change\n'.repeat(400_000)}`)
  const daemon = await startDaemon()
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const request = { op: 'review.diff_page', workspace_id: workspace.id, path: 'tracked.txt', staged: false }
    const first = (await rpc(daemon.socket, request, 20_000)) as DiffPage
    expect(first.type).toBe('review_diff_page')
    expect(first.bytes).toBeGreaterThan(4 * 1024 * 1024)
    expect(first.rows.length).toBeLessThanOrEqual(1000)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(256 * 1024)
    expect(first.complete).toBe(false)
    expect(first.next_cursor).toBeTruthy()
    const second = (await rpc(
      daemon.socket,
      { ...request, cursor: first.next_cursor, expected_token: first.token },
      20_000,
    )) as DiffPage
    expect(second.token).toBe(first.token)
    expect(second.revision).toBe(first.revision)
    expect(
      second.rows.some(
        (row) =>
          row.kind === 'added' &&
          row.new_line !== null &&
          row.new_line > 1000 &&
          row.text === '+large change' &&
          !row.truncated,
      ),
    ).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(256 * 1024)
    expect(second.next_cursor).toBeTruthy()
    await writeFile(join(checkout, 'tracked.txt'), 'baseline\nchanged after review\n')
    await expect(
      rpc(daemon.socket, { ...request, cursor: second.next_cursor, expected_token: first.token }, 20_000),
    ).rejects.toThrow(/Stale diff/i)
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
