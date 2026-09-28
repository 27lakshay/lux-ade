import { call } from '@ade/client'
import { CliError, effectOperationId, parseWords, positionals, type CommandResult } from '../shared.js'

export const reviewUsage = `  review send CONVERSATION_ID --anchors JSON --note TEXT [--window ID]
  review send CONVERSATION_ID --feedback JSON [--window ID]
                                        Queue review feedback on a conversation: anchors from
                                        review.diff_page with one note, or ade-review-feedback-v1
                                        with a note per anchor. A stale anchor is refused
`

function json(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new CliError('usage', `${label} must be valid JSON.`)
  }
}

export async function runReviewCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'review' || action !== 'send') return undefined
  const parsed = parseWords(rest, ['--anchors', '--note', '--feedback', '--window'], [], 'review send')
  const [conversationId] = positionals(parsed, 1, 'review send requires CONVERSATION_ID')
  const { '--anchors': anchors, '--note': note, '--feedback': feedback, '--window': window } = parsed.options
  if (feedback ? anchors || note : !anchors || !note) {
    throw new CliError('usage', 'review send takes --anchors JSON with --note TEXT, or --feedback JSON.')
  }
  const listed = anchors ? json(anchors, '--anchors') : undefined
  return call(socketPath, 'review.feedback.send', {
    operation_id: effectOperationId(),
    conversation_id: conversationId!,
    ...(listed !== undefined ? { anchors: (Array.isArray(listed) ? listed : [listed]) as never, note: note! } : {}),
    ...(feedback ? { feedback: json(feedback, '--feedback') as never } : {}),
    ...(window ? { window_id: window } : {}),
  })
}
