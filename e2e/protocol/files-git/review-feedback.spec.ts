// Review diff pages and review feedback: a large diff is read in bounded pages
// that refuse a changed revision; feedback anchored to diff lines is sent to a
// conversation once, kept with its structured anchors across a restart, and
// found again by search. Ported from the legacy e2e/specs/review-diff-page,
// review-cli-parity and review-feedback-batch specs.
import { expect, startConversation, test, waitForIdle, type ScratchProfile } from '../fixtures'
import { openWorkspace } from './steps'

type Row = { kind: string; new_line: number | null; text: string; hunk: string; truncated?: boolean }
type Page = {
  type: string
  revision: string
  token: string
  path: string
  staged: boolean
  rows: Row[]
  next_cursor: string | null
  complete: boolean
  bytes: number
}

async function turnStarts(profile: ScratchProfile): Promise<number> {
  return (await profile.mockCalls('codex')).filter((call) => call.method === 'turn/start').length
}

async function messageIds(profile: ScratchProfile, conversationId: string): Promise<string[]> {
  return (await profile.call('conversation.get', { conversation_id: conversationId })).messages.map(
    (message) => (message as { id: string }).id,
  )
}

test('large diff pages expose later lines and reject a changed revision', async ({ ade, profile }) => {
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', `baseline\n${'large change\n'.repeat(400_000)}`)
  const workspace_id = await openWorkspace(profile, repo.path)
  const request = { workspace_id, path: 'tracked.txt', staged: false }
  const first = (await profile.call('review.diff_page', request, { timeoutMs: 20_000 })) as unknown as Page
  expect(first.type).toBe('review_diff_page')
  expect(first.bytes).toBeGreaterThan(4 * 1024 * 1024)
  expect(first.rows.length).toBeLessThanOrEqual(1000)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(256 * 1024)
  expect(first.complete).toBe(false)
  expect(first.next_cursor).toBeTruthy()
  const second = (await profile.call(
    'review.diff_page',
    { ...request, cursor: first.next_cursor!, expected_token: first.token },
    { timeoutMs: 20_000 },
  )) as unknown as Page
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
  await repo.write('tracked.txt', 'baseline\nchanged after review\n')
  await expect(
    profile.call(
      'review.diff_page',
      { ...request, cursor: second.next_cursor!, expected_token: first.token },
      { timeoutMs: 20_000 },
    ),
  ).rejects.toThrow(/Stale diff/i)
})

test('named CLI commands page a large diff and search retained review notes', async ({ ade, profile }) => {
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', `baseline\n${'changed\n'.repeat(1_500)}`)
  const workspaceId = await openWorkspace(profile, repo.path)

  const first = await profile.cli('git', 'diff-page', workspaceId, 'tracked.txt', 'unstaged')
  expect(first).toMatchObject({
    code: 0,
    json: {
      type: 'review_diff_page',
      staged: false,
      path: 'tracked.txt',
      complete: false,
      next_cursor: expect.any(String),
    },
  })
  const firstPage = first.json as unknown as Page & { next_cursor: string }
  expect(firstPage.rows.length).toBeLessThanOrEqual(1000)
  const second = await profile.cli(
    'git',
    'diff-page',
    workspaceId,
    'tracked.txt',
    'unstaged',
    '--cursor',
    firstPage.next_cursor,
    '--expected-token',
    firstPage.token,
  )
  expect(second).toMatchObject({
    code: 0,
    json: {
      token: firstPage.token,
      rows: expect.arrayContaining([expect.objectContaining({ new_line: 1001, text: '+changed' })]),
    },
  })
  expect(await profile.cli('git', 'diff-page', workspaceId, 'tracked.txt', 'invalid')).toMatchObject({
    code: 2,
    json: { code: 'usage' },
  })
  // A cursor without the token it belongs to is a usage error.
  expect(
    await profile.cli('git', 'diff-page', workspaceId, 'tracked.txt', 'unstaged', '--cursor', firstPage.next_cursor),
  ).toMatchObject({ code: 2, json: { code: 'usage' } })

  const line = firstPage.rows.find((row) => row.kind === 'added' && row.new_line === 2)
  expect(line).toBeDefined()
  const { conversationId } = await startConversation(profile, 'codex', repo.path)
  const feedback = {
    format: 'ade-review-feedback-v1',
    workspace_id: workspaceId,
    notes: [
      {
        anchor: {
          workspace_id: workspaceId,
          path: 'tracked.txt',
          staged: false,
          revision: firstPage.revision,
          token: firstPage.token,
          hunk: line!.hunk,
          line: line!.new_line,
          text: line!.text,
        },
        note: 'Review this changed line',
      },
    ],
  }
  const sendFeedback = (id: string, body: unknown) =>
    profile.cli('git', 'feedback-send', conversationId, id, JSON.stringify(body))
  const ack = { code: 0, json: { type: 'ack', request_id: 'cli-parity-feedback' } }
  expect(await sendFeedback('cli-parity-feedback', feedback)).toMatchObject(ack)
  expect(await sendFeedback('cli-parity-feedback', feedback)).toMatchObject(ack)
  const changedFeedback = { ...feedback, notes: [{ ...feedback.notes[0], note: 'Changed note' }] }
  expect(await sendFeedback('cli-parity-feedback', changedFeedback)).toMatchObject({
    code: 7,
    json: { code: 'daemon' },
  })

  const found = await profile.cli(
    'git',
    'feedback-search',
    workspaceId,
    '--path',
    'tracked.txt',
    '--query',
    'changed line',
    '--limit',
    '1',
  )
  expect(found).toMatchObject({
    code: 0,
    json: {
      type: 'review_feedback_search',
      results: [{ message_id: 'cli-parity-feedback', review_feedback: { notes: [feedback.notes[0]] } }],
    },
  })
  expect(
    await profile.cli(
      'git',
      'feedback-search',
      workspaceId,
      '--query',
      'changed line',
      '--before',
      '999999999',
      '--limit',
      '1',
    ),
  ).toMatchObject({ code: 0, json: { results: [{ message_id: 'cli-parity-feedback' }] } })
  expect(await profile.cli('git', 'feedback-search', workspaceId, '--limit', '1')).toMatchObject({
    code: 2,
    json: { code: 'usage' },
  })
  expect(await profile.cli('git', 'feedback-search', workspaceId, '--query', 'changed', '--before', '0')).toMatchObject(
    { code: 2, json: { code: 'usage' } },
  )
  expect(await sendFeedback('invalid-feedback', { ...feedback, notes: [] })).toMatchObject({
    code: 2,
    json: { code: 'usage' },
  })

  // Feedback anchored to a diff that changed is refused before admission, and stays refused.
  await waitForIdle(profile, conversationId)
  await repo.write('tracked.txt', 'baseline\nchanged after review\n')
  expect(await sendFeedback('cli-parity-stale', feedback)).toMatchObject({
    code: 27,
    json: { code: 'review_anchor_stale', message: expect.stringMatching(/Stale diff/i) },
  })
  expect(
    await sendFeedback('cli-parity-stale', {
      ...feedback,
      notes: [{ ...feedback.notes[0], note: 'Reused stale ID with changed feedback' }],
    }),
  ).toMatchObject({
    code: 7,
    json: { code: 'daemon', message: expect.stringMatching(/already used for a different prompt/i) },
  })
  expect(await sendFeedback('cli-parity-stale', feedback)).toMatchObject({
    code: 7,
    json: { code: 'daemon', message: expect.stringMatching(/rejected before admission/i) },
  })
  expect(await messageIds(profile, conversationId)).not.toContain('cli-parity-stale')
  expect(await turnStarts(profile)).toBe(1)
  const stale = await profile.cli(
    'git',
    'diff-page',
    workspaceId,
    'tracked.txt',
    'unstaged',
    '--cursor',
    firstPage.next_cursor,
    '--expected-token',
    firstPage.token,
  )
  expect(stale).toMatchObject({ code: 7, json: { code: 'daemon', message: expect.stringMatching(/Stale diff/i) } })
})

test('batch feedback admits every range together and retains structured anchors after restart', async ({
  ade,
  profile,
}) => {
  const repo = await ade.repo({ initialFiles: { 'tracked.txt': 'baseline\n' } })
  await repo.write('tracked.txt', 'baseline\nfirst\nsecond\nthird\n')
  const { workspaceId, conversationId } = await startConversation(profile, 'codex', repo.path)
  const owner = { conversation_id: conversationId, window_id: 'review-window' }
  const page = (await profile.call('review.diff_page', {
    workspace_id: workspaceId,
    path: 'tracked.txt',
    staged: false,
  })) as unknown as Page
  const line = (number: number) => {
    const row = page.rows.find((item) => item.kind === 'added' && item.new_line === number)
    if (!row) throw new Error(`Missing diff line ${number}`)
    return row
  }
  const anchor = (number: number) => ({
    workspace_id: workspaceId,
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
    workspace_id: workspaceId,
    notes: [
      { anchor: { ...anchor(2), end_line: 3, end_text: line(3).text }, note: 'Review the range' },
      { anchor: anchor(4), note: 'Review the final line' },
    ],
  }
  const draft = 'Review tracked.txt lines 2-4: Review the range; Review the final line'
  const sendReview = (request_id: string, review_feedback: typeof feedback) =>
    profile.call('agent.send_review', { conversation_id: conversationId, request_id, text: draft, review_feedback })
  const prepare = (window: typeof owner, request_id: string, review_feedback: typeof feedback) =>
    profile.call('draft.send.prepare', {
      ...window,
      request_id,
      draft_text: draft,
      revision: 1,
      text: draft,
      review_feedback,
    })
  await profile.call('draft.save', { ...owner, text: draft, revision: 1 })

  // One wrong anchor refuses the whole batch; nothing is admitted.
  const invalid = {
    ...feedback,
    notes: [feedback.notes[0], { ...feedback.notes[1], anchor: { ...anchor(4), text: '+wrong' } }],
  }
  await prepare(owner, 'review-bad', invalid)
  await expect(sendReview('review-bad', invalid)).rejects.toThrow('Stale diff')
  expect(await messageIds(profile, conversationId)).toEqual([])
  expect(await profile.call('draft.send.get', owner)).toMatchObject({
    intent: { request_id: 'review-bad', state: 'rejected' },
  })
  await profile.call('draft.send.abort', { ...owner, request_id: 'review-bad' })

  expect(await prepare(owner, 'review-batch', feedback)).toMatchObject({ intent: { review_feedback: feedback } })
  expect(await profile.call('draft.send.get', owner)).toMatchObject({ intent: { review_feedback: feedback } })
  await expect(prepare(owner, 'review-batch', { ...feedback, notes: [feedback.notes[0]] })).rejects.toThrow(
    'different prompt',
  )
  await sendReview('review-batch', feedback)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'review-batch', review_feedback: feedback })]),
  )
  expect(
    await profile.call('review.feedback.search', {
      workspace_id: workspaceId,
      path: 'tracked.txt',
      query: 'final line',
    }),
  ).toMatchObject({
    type: 'review_feedback_search',
    results: [
      {
        message_id: 'review-batch',
        conversation_id: conversationId,
        review_feedback: { notes: [feedback.notes[1]] },
      },
    ],
  })
  await waitForIdle(profile, conversationId)
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'review-batch', review_feedback: feedback })]),
  )
  // The same send again converges on the admitted one.
  await expect(sendReview('review-batch', feedback)).resolves.toMatchObject({ type: 'ack' })

  // A file changed after selection makes a prepared review stale.
  const staleOwner = { conversation_id: conversationId, window_id: 'review-stale-window' }
  await profile.call('draft.save', { ...staleOwner, text: draft, revision: 1 })
  await prepare(staleOwner, 'review-stale-file', feedback)
  await repo.write('tracked.txt', 'baseline\nfirst\nchanged after selection\nthird\n')
  await expect(sendReview('review-stale-file', feedback)).rejects.toThrow('Stale diff')
  expect(await profile.call('draft.send.get', staleOwner)).toMatchObject({
    intent: { request_id: 'review-stale-file', state: 'rejected' },
  })
  expect(await turnStarts(profile)).toBe(1)

  await profile.restartDaemon()
  expect((await profile.call('conversation.get', { conversation_id: conversationId })).messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'review-batch', text: draft, review_feedback: feedback })]),
  )
  expect(await profile.call('review.feedback.search', { workspace_id: workspaceId, query: 'range' })).toMatchObject({
    results: [{ message_id: 'review-batch', review_feedback: { notes: [feedback.notes[0]] } }],
  })
})
