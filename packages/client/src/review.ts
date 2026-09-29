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
