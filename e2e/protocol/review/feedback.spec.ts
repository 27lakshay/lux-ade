// `review.feedback.send` (daemon authority ticket 03): the daemon builds the
// review prompt the desktop used to build, checks every anchor against the
// workspace's current status and diff, and queues the prompt on the
// Conversation; the delivered message keeps the feedback for search.
import type { ReviewFeedback } from '../../../packages/client/dist/index.js'
import { expect, test, type ScratchProfile, type ScratchRepo } from '../fixtures'
import { operationId } from '../worktrees/lifecycle'

/** The batch prompt clients built before the daemon did (the SDK's former `formatReviewFeedback`). */
function formatReviewFeedback(feedback: ReviewFeedback): string {
  const notes = feedback.notes.map(
    ({ anchor, note }, index) =>
      `${index + 1}. File: ${anchor.path}\nSide: ${anchor.staged ? 'staged' : 'unstaged'}\n` +
      `Diff token: ${anchor.token}\nStatus revision: ${anchor.revision}\nHunk: ${anchor.hunk}\n` +
      `${anchor.end_line === undefined ? 'Line' : 'Lines'}: +${anchor.line}${anchor.end_line === undefined ? '' : ` to +${anchor.end_line}`}\n` +
      `Selected text: ${anchor.text}${anchor.end_text === undefined ? '' : `\nEnd text: ${anchor.end_text}`}\n` +
      `Feedback: ${note.trim()}`,
  )
  return `Review feedback for workspace ${feedback.workspace_id}\n\n${notes.join('\n\n')}`
}

type Anchor = {
  workspace_id: string
  path: string
  staged: boolean
  revision: string
  token: string
  hunk: string
  line: number
  text: string
}

/** The anchor `review.diff_page` gives for added line `line` of `path`. */
async function anchorAt(profile: ScratchProfile, workspaceId: string, path: string, line: number): Promise<Anchor> {
  const page = await profile.call('review.diff_page', { workspace_id: workspaceId, path, staged: false })
  const row = page.rows.find((item) => item.kind === 'added' && item.new_line === line)!
  return {
    workspace_id: workspaceId,
    path,
    staged: false,
    revision: page.revision,
    token: page.token,
    hunk: row.hunk,
    line,
    text: row.text,
  }
}

/** The one-line prompt the desktop built (`reviewPromptText` in apps/desktop/src/main/review.ts). */
function desktopPrompt(anchor: Anchor, note: string): string {
  return `Review feedback for workspace ${anchor.workspace_id}\nFile: ${anchor.path}\nSide: ${anchor.staged ? 'staged' : 'unstaged'}\nDiff token: ${anchor.token}\nStatus revision: ${anchor.revision}\nHunk: ${anchor.hunk}\nLine: +${anchor.line}\nSelected text: ${anchor.text}\n\nFeedback:\n${note.trim()}`
}

async function changed(profile: ScratchProfile, repo: ScratchRepo) {
  await repo.commit('Track a file', { 'tracked.txt': 'baseline\n' })
  await repo.write('tracked.txt', 'baseline\nfirst\nsecond\n')
  const { workspace } = await profile.call('workspace.open', { path: repo.path })
  const { conversation } = await profile.call('conversation.create', { workspace_id: workspace.id, provider: 'codex' })
  return { workspaceId: workspace.id, conversationId: conversation.id }
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string }> {
  return promise.then(
    () => {
      throw new Error('The call was expected to be refused')
    },
    (failure: unknown) => failure as { code: string },
  )
}

test('feedback on one line queues the desktop prompt, reaches the conversation with its feedback, and replays', async ({
  profile,
  repo,
}) => {
  const { workspaceId, conversationId } = await changed(profile, repo)
  const anchor = await anchorAt(profile, workspaceId, 'tracked.txt', 2)
  const id = operationId('feedback')
  const sent = await profile.cli(
    '--operation-id',
    id,
    'review',
    'send',
    conversationId,
    '--anchors',
    JSON.stringify([anchor]),
    '--note',
    '  Check this line  ',
  )
  expect(sent.code, sent.stderr).toBe(0)
  expect(sent.json).toEqual({
    type: 'review_feedback_queued',
    conversation_id: conversationId,
    queued_prompt_id: id,
    text: desktopPrompt(anchor, 'Check this line'),
  })

  // The queue delivers it; the user message keeps the feedback.
  let delivered: { text: string; review_feedback?: unknown } | undefined
  await expect
    .poll(async () => {
      const { messages } = await profile.call('conversation.get', { conversation_id: conversationId })
      delivered = (messages as Array<{ id: string; role: string; text: string; review_feedback?: unknown }>).find(
        (message) => message.id === id,
      )
      return delivered?.text
    })
    .toBe(desktopPrompt(anchor, 'Check this line'))
  expect(delivered?.review_feedback).toEqual({
    format: 'ade-review-feedback-v1',
    workspace_id: workspaceId,
    notes: [{ anchor, note: '  Check this line  ' }],
  })
  const search = await profile.call('review.feedback.search', { workspace_id: workspaceId, query: 'Check this line' })
  expect(search.results.map((result) => result.message_id)).toContain(id)

  // A retry replays the reply and queues nothing more; another request under the ID conflicts.
  const replay = await profile.call('review.feedback.send', {
    operation_id: id,
    conversation_id: conversationId,
    anchors: [anchor],
    note: '  Check this line  ',
  })
  expect(replay).toEqual(sent.json)
  const { messages } = await profile.call('conversation.get', { conversation_id: conversationId })
  expect((messages as Array<{ id: string }>).filter((message) => message.id === id)).toHaveLength(1)
  const conflict = await refusal(
    profile.call('review.feedback.send', {
      operation_id: id,
      conversation_id: conversationId,
      anchors: [anchor],
      note: 'x',
    }),
  )
  expect(conflict.code).toBe('conflict')
})

test('a batch with a note per anchor queues the client batch prompt', async ({ profile, repo }) => {
  const { workspaceId, conversationId } = await changed(profile, repo)
  const feedback: ReviewFeedback = {
    format: 'ade-review-feedback-v1',
    workspace_id: workspaceId,
    notes: [
      { anchor: await anchorAt(profile, workspaceId, 'tracked.txt', 2), note: 'Why first?' },
      { anchor: await anchorAt(profile, workspaceId, 'tracked.txt', 3), note: 'And second' },
    ],
  }
  const sent = await profile.call('review.feedback.send', {
    conversation_id: conversationId,
    feedback: feedback as never,
  })
  expect(sent.text).toBe(formatReviewFeedback(feedback))
})

test('a stale anchor, a filled draft and a conversation in another workspace are refused before queueing', async ({
  ade,
  profile,
  repo,
}) => {
  const { workspaceId, conversationId } = await changed(profile, repo)
  const anchor = await anchorAt(profile, workspaceId, 'tracked.txt', 2)

  // The window's draft would be replaced: refused until it is empty.
  await profile.call('draft.save', {
    conversation_id: conversationId,
    window_id: 'window_1',
    text: 'half-written',
    revision: 1,
  })
  const draft = await refusal(
    profile.call('review.feedback.send', {
      conversation_id: conversationId,
      anchors: [anchor],
      note: 'x',
      window_id: 'window_1',
    }),
  )
  expect(draft.code).toBe('draft_not_empty')

  // The file moved after the anchor was read.
  await repo.write('tracked.txt', 'baseline\nchanged\nsecond\n')
  const stale = await refusal(
    profile.call('review.feedback.send', { conversation_id: conversationId, anchors: [anchor], note: 'x' }),
  )
  expect(stale.code).toBe('review_anchor_stale')
  const cli = await profile.cli('review', 'send', conversationId, '--anchors', JSON.stringify(anchor), '--note', 'x')
  expect(cli.code).toBe(27)
  expect(cli.json).toMatchObject({ code: 'review_anchor_stale', recovery: 'refresh_changes' })

  // An anchor from another workspace does not belong to this conversation.
  const other = await ade.repo({ name: 'other' })
  const { conversationId: elsewhere } = await changed(profile, other)
  const foreign = await refusal(
    profile.call('review.feedback.send', { conversation_id: elsewhere, anchors: [anchor], note: 'x' }),
  )
  expect(foreign.code).not.toBe('conflict')
  const { queued } = await profile.call('conversation.get', { conversation_id: conversationId })
  expect(queued).toEqual([])
})

test('feedback whose prompt would pass the queue limit is refused by name', async ({ profile, repo }) => {
  const { workspaceId, conversationId } = await changed(profile, repo)
  const anchor = await anchorAt(profile, workspaceId, 'tracked.txt', 2)
  const note = 'n'.repeat(4000)
  const feedback = {
    format: 'ade-review-feedback-v1',
    workspace_id: workspaceId,
    notes: Array.from({ length: 16 }, () => ({ anchor, note })),
  }
  const long = await refusal(
    profile.call('review.feedback.send', { conversation_id: conversationId, feedback: feedback as never }),
  )
  expect(long.code).toBe('review_prompt_too_long')
})
