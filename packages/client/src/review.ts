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

/** Whether two review feedback values are the same, whatever their key order. */
export function sameReviewFeedback(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string =>
    JSON.stringify(value ?? null, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    )
  return canonical(left) === canonical(right)
}

const reviewAnchorFields = ['workspace_id', 'path', 'staged', 'revision', 'token', 'hunk', 'line', 'text'] as const

/** Whether two single-line review anchors name the same line; two missing anchors match. */
export function sameReviewAnchor(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null
  if (typeof left !== 'object' || typeof right !== 'object') return false
  return reviewAnchorFields.every(
    (field) => (left as Record<string, unknown>)[field] === (right as Record<string, unknown>)[field],
  )
}

export function formatReviewFeedback(feedback: ReviewFeedback): string {
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
