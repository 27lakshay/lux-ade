import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { rpc, startDaemon } from '../fixtures/daemon'

const run = promisify(execFile)

type Row = { kind: string; new_line: number | null; text: string; hunk: string }
type Page = { revision: string; token: string; rows: Row[] }

test('batch feedback admits every range together and retains structured anchors after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-review-batch-'))
  const checkout = join(directory, 'checkout')
  const data = join(directory, 'data')
  const mock = join(directory, 'codex')
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
  await writeFile(join(checkout, 'tracked.txt'), 'baseline\nfirst\nsecond\nthird\n')
  const environment = {
    ADE_DATA_DIR: data,
    ADE_CODEX_BIN: resolve('scripts/fixtures/codex_mock.py'),
    ADE_CODEX_TRANSPORT: 'stdio',
    ADE_MOCK_DIR: mock,
  }
  let daemon = await startDaemon(environment)
  try {
    const workspace = (await rpc(daemon.socket, { op: 'workspace.open', path: checkout })).workspace as { id: string }
    const conversation = (
      await rpc(daemon.socket, { op: 'conversation.create', workspace_id: workspace.id, provider: 'codex' })
    ).conversation as { id: string }
    const owner = { conversation_id: conversation.id, window_id: 'review-window' }
    const page = (await rpc(daemon.socket, {
      op: 'review.diff_page',
      workspace_id: workspace.id,
      path: 'tracked.txt',
      staged: false,
    })) as Page
    const line = (number: number) => {
      const row = page.rows.find((item) => item.kind === 'added' && item.new_line === number)
      if (!row) throw new Error(`Missing diff line ${number}`)
      return row
    }
    const anchor = (number: number) => ({
      workspace_id: workspace.id,
      path: 'tracked.txt',
      staged: false,
      revision: page.revision,
      token: page.token,
      hunk: line(number).hunk,
      line: number,
      text: line(number).text,
    })
    const feedback = {
      format: 'ade-review-feedback-v1',
      workspace_id: workspace.id,
      notes: [
        { anchor: { ...anchor(2), end_line: 3, end_text: line(3).text }, note: 'Review the range' },
        { anchor: anchor(4), note: 'Review the final line' },
      ],
    }
    const draft = 'Review tracked.txt lines 2-4: Review the range; Review the final line'
    await rpc(daemon.socket, { op: 'draft.save', ...owner, text: draft, revision: 1 })
    const invalid = {
      ...feedback,
      notes: [feedback.notes[0], { ...feedback.notes[1], anchor: { ...anchor(4), text: '+wrong' } }],
    }
    await rpc(daemon.socket, {
      op: 'draft.send.prepare',
      ...owner,
      request_id: 'review-bad',
      draft_text: draft,
      revision: 1,
      text: draft,
      review_feedback: invalid,
    })
    await expect(
      rpc(daemon.socket, {
        op: 'agent.send_review',
        conversation_id: conversation.id,
        request_id: 'review-bad',
        text: draft,
        review_feedback: invalid,
      }),
    ).rejects.toThrow('Stale diff')
    expect(
      (await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id }).then(
        (value) => value.messages,
      )) as unknown[],
    ).toEqual([])
    expect(await rpc(daemon.socket, { op: 'draft.send.get', ...owner })).toMatchObject({
      intent: { request_id: 'review-bad', state: 'rejected' },
    })
    await rpc(daemon.socket, { op: 'draft.send.abort', ...owner, request_id: 'review-bad' })
    const prepare = {
      op: 'draft.send.prepare',
      ...owner,
      request_id: 'review-batch',
      draft_text: draft,
      revision: 1,
      text: draft,
      review_feedback: feedback,
    }
    expect(await rpc(daemon.socket, prepare)).toMatchObject({ intent: { review_feedback: feedback } })
    expect(await rpc(daemon.socket, { op: 'draft.send.get', ...owner })).toMatchObject({
      intent: { review_feedback: feedback },
    })
    await expect(
      rpc(daemon.socket, { ...prepare, review_feedback: { ...feedback, notes: [feedback.notes[0]] } }),
    ).rejects.toThrow('different prompt')
    await rpc(daemon.socket, {
      op: 'agent.send_review',
      conversation_id: conversation.id,
      request_id: 'review-batch',
      text: draft,
      review_feedback: feedback,
    })
    const snapshot = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'review-batch',
          review_feedback: feedback,
        }),
      ]),
    )
    expect(
      await rpc(daemon.socket, {
        op: 'review.feedback.search',
        workspace_id: workspace.id,
        path: 'tracked.txt',
        query: 'final line',
      }),
    ).toMatchObject({
      type: 'review_feedback_search',
      results: [
        {
          message_id: 'review-batch',
          conversation_id: conversation.id,
          review_feedback: { notes: [feedback.notes[1]] },
        },
      ],
    })
    await expect
      .poll(
        async () =>
          (await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })).conversation as {
            status: string
          },
      )
      .toMatchObject({ status: 'ready' })
    expect(await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ id: 'review-batch', review_feedback: feedback })]),
    })
    await expect(
      rpc(daemon.socket, {
        op: 'agent.send_review',
        conversation_id: conversation.id,
        request_id: 'review-batch',
        text: draft,
        review_feedback: feedback,
      }),
    ).resolves.toMatchObject({ type: 'ack' })
    const staleOwner = { conversation_id: conversation.id, window_id: 'review-stale-window' }
    await rpc(daemon.socket, { op: 'draft.save', ...staleOwner, text: draft, revision: 1 })
    await rpc(daemon.socket, {
      op: 'draft.send.prepare',
      ...staleOwner,
      request_id: 'review-stale-file',
      draft_text: draft,
      revision: 1,
      text: draft,
      review_feedback: feedback,
    })
    await writeFile(join(checkout, 'tracked.txt'), 'baseline\nfirst\nchanged after selection\nthird\n')
    await expect(
      rpc(daemon.socket, {
        op: 'agent.send_review',
        conversation_id: conversation.id,
        request_id: 'review-stale-file',
        text: draft,
        review_feedback: feedback,
      }),
    ).rejects.toThrow('Stale diff')
    expect(await rpc(daemon.socket, { op: 'draft.send.get', ...staleOwner })).toMatchObject({
      intent: { request_id: 'review-stale-file', state: 'rejected' },
    })
    const calls = (await readFile(join(mock, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(calls.filter((line) => JSON.parse(line).method === 'turn/start')).toHaveLength(1)
    await daemon.stop()
    daemon = await startDaemon(environment)
    const restored = await rpc(daemon.socket, { op: 'conversation.get', conversation_id: conversation.id })
    expect(restored.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'review-batch',
          text: draft,
          review_feedback: feedback,
        }),
      ]),
    )
    expect(
      await rpc(daemon.socket, { op: 'review.feedback.search', workspace_id: workspace.id, query: 'range' }),
    ).toMatchObject({ results: [{ message_id: 'review-batch', review_feedback: { notes: [feedback.notes[0]] } }] })
  } finally {
    await daemon.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
