/** Structured review feedback shared by desktop and headless callers. */
export type ReviewAnchor = {
  workspace_id: string
  path: string
  staged: boolean
  revision: string
  token: string
  hunk: string
  line: number
  text: string
  end_line?: number
  end_text?: string
}

export type ReviewFeedback = {
  format: 'ade-review-feedback-v1'
  workspace_id: string
  notes: { anchor: ReviewAnchor; note: string }[]
}

export function formatReviewFeedback(feedback: ReviewFeedback): string {
  const notes = feedback.notes.map(({ anchor, note }, index) =>
    `${index + 1}. File: ${anchor.path}\nSide: ${anchor.staged ? 'staged' : 'unstaged'}\n` +
    `Diff token: ${anchor.token}\nStatus revision: ${anchor.revision}\nHunk: ${anchor.hunk}\n` +
    `${anchor.end_line === undefined ? 'Line' : 'Lines'}: +${anchor.line}${anchor.end_line === undefined ? '' : ` to +${anchor.end_line}`}\n` +
    `Selected text: ${anchor.text}${anchor.end_text === undefined ? '' : `\nEnd text: ${anchor.end_text}`}\n` +
    `Feedback: ${note.trim()}`)
  return `Review feedback for workspace ${feedback.workspace_id}\n\n${notes.join('\n\n')}`
}
