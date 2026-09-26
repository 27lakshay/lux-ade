import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')

async function ade(socket: string, ...args: string[]): Promise<{ code: number; body: Record<string, unknown> }> {
  try {
    const output = await run(process.execPath, [cli, '--socket', socket, ...args], { timeout: 20_000 })
    return { code: 0, body: JSON.parse(output.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    return { code: failure.code, body: JSON.parse(failure.stderr) as Record<string, unknown> }
  }
}

test('named CLI commands page a large diff and search retained review notes', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'ade-review-cli-e2e-'))
  const checkout = join(directory, 'checkout')
  await run('git', ['init', '-q', '-b', 'main', checkout])
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\n')
  await run('git', ['-C', checkout, 'add', 'tracked.txt'])
  await run('git', ['-C', checkout, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.test',
    'commit', '-qm', 'baseline'])
  await writeFile(join(checkout, 'tracked.txt'), `baseline\n${'changed\n'.repeat(1_500)}`)
  const daemon = await startDaemon({ ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio', ADE_MOCK_DIR: join(directory, 'mock') })
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const first = await ade(daemon.socket, 'git', 'diff-page', workspace.id, 'tracked.txt', 'unstaged')
    expect(first).toMatchObject({ code: 0, body: { type: 'review_diff_page', staged: false,
      path: 'tracked.txt', complete: false, next_cursor: expect.any(String) } })
    const firstPage = first.body as { rows: Array<{ kind: string; new_line: number; text: string; hunk: string }>;
      next_cursor: string; token: string; revision: string }
    expect(firstPage.rows.length).toBeLessThanOrEqual(1000)
    const second = await ade(daemon.socket, 'git', 'diff-page', workspace.id, 'tracked.txt', 'unstaged',
      '--cursor', firstPage.next_cursor, '--expected-token', firstPage.token)
    expect(second).toMatchObject({ code: 0, body: { token: firstPage.token,
      rows: expect.arrayContaining([expect.objectContaining({ new_line: 1001, text: '+changed' })]) } })
    const badSide = await ade(daemon.socket, 'git', 'diff-page', workspace.id, 'tracked.txt', 'invalid')
    expect(badSide).toMatchObject({ code: 2, body: { code: 'usage' } })
    const badCursor = await ade(daemon.socket, 'git', 'diff-page', workspace.id, 'tracked.txt', 'unstaged',
      '--cursor', firstPage.next_cursor)
    expect(badCursor).toMatchObject({ code: 2, body: { code: 'usage' } })

    const line = firstPage.rows.find((row) => row.kind === 'added' && row.new_line === 2)
    expect(line).toBeDefined()
    const conversation = (await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id,
      provider: 'codex' })).conversation as { id: string }
    const feedback = { format: 'ade-review-feedback-v1', workspace_id: workspace.id, notes: [
      { anchor: { workspace_id: workspace.id, path: 'tracked.txt', staged: false,
        revision: firstPage.revision, token: firstPage.token, hunk: line!.hunk,
        line: line!.new_line, text: line!.text }, note: 'Review this changed line' },
    ] }
    const sent = await ade(daemon.socket, 'git', 'feedback-send', conversation.id,
      'cli-parity-feedback', JSON.stringify(feedback))
    expect(sent).toMatchObject({ code: 0, body: { type: 'ack', request_id: 'cli-parity-feedback' } })
    expect(await ade(daemon.socket, 'git', 'feedback-send', conversation.id,
      'cli-parity-feedback', JSON.stringify(feedback))).toMatchObject({
      code: 0, body: { type: 'ack', request_id: 'cli-parity-feedback' },
    })
    const changedFeedback = { ...feedback, notes: [{ ...feedback.notes[0], note: 'Changed note' }] }
    expect(await ade(daemon.socket, 'git', 'feedback-send', conversation.id,
      'cli-parity-feedback', JSON.stringify(changedFeedback))).toMatchObject({
      code: 7, body: { code: 'daemon' },
    })
    const found = await ade(daemon.socket, 'git', 'feedback-search', workspace.id,
      '--path', 'tracked.txt', '--query', 'changed line', '--limit', '1')
    expect(found).toMatchObject({ code: 0, body: { type: 'review_feedback_search',
      results: [{ message_id: 'cli-parity-feedback', review_feedback: { notes: [feedback.notes[0]] } }] } })
    expect(await ade(daemon.socket, 'git', 'feedback-search', workspace.id,
      '--query', 'changed line', '--before', '999999999', '--limit', '1')).toMatchObject({
      code: 0, body: { results: [{ message_id: 'cli-parity-feedback' }] },
    })
    expect(await ade(daemon.socket, 'git', 'feedback-search', workspace.id, '--limit', '1'))
      .toMatchObject({ code: 2, body: { code: 'usage' } })
    expect(await ade(daemon.socket, 'git', 'feedback-search', workspace.id,
      '--query', 'changed', '--before', '0')).toMatchObject({ code: 2, body: { code: 'usage' } })
    expect(await ade(daemon.socket, 'git', 'feedback-send', conversation.id,
      'invalid-feedback', JSON.stringify({ ...feedback, notes: [] }))).toMatchObject({
      code: 2, body: { code: 'usage' },
    })
    await expect.poll(async () => (await rpc(daemon.socket, { op: 'conversation.get',
      conversation_id: conversation.id })).conversation as { status: string }).toMatchObject({ status: 'ready' })
    await writeFile(join(checkout, 'tracked.txt'), 'baseline\nchanged after review\n')
    expect(await ade(daemon.socket, 'git', 'feedback-send', conversation.id,
      'cli-parity-stale', JSON.stringify(feedback))).toMatchObject({
      code: 7, body: { code: 'daemon', message: expect.stringMatching(/Stale diff/i) },
    })
    expect(await ade(daemon.socket, 'git', 'feedback-send', conversation.id,
      'cli-parity-stale', JSON.stringify({ ...feedback, notes: [{ ...feedback.notes[0],
        note: 'Reused stale ID with changed feedback' }] }))).toMatchObject({
      code: 7, body: { code: 'daemon', message: expect.stringMatching(/already used for a different prompt/i) },
    })
    expect(await ade(daemon.socket, 'git', 'feedback-send', conversation.id,
      'cli-parity-stale', JSON.stringify(feedback))).toMatchObject({
      code: 7, body: { code: 'daemon', message: expect.stringMatching(/rejected before admission/i) },
    })
    expect((await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
      .then((value) => value.messages)) as Array<{ id: string }>).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'cli-parity-stale' })]))
    const calls = (await readFile(join(directory, 'mock', 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
    const stale = await ade(daemon.socket, 'git', 'diff-page', workspace.id, 'tracked.txt', 'unstaged',
      '--cursor', firstPage.next_cursor, '--expected-token', firstPage.token)
    expect(stale).toMatchObject({ code: 7, body: { code: 'daemon', message: expect.stringMatching(/Stale diff/i) } })
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
