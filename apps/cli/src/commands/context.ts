import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const contextUsage = `  context file CONVERSATION_ID REQUEST_ID WORKSPACE_ID PATH --lines START-END
                                        Capture file lines as a conversation attachment
  context hunk CONVERSATION_ID REQUEST_ID WORKSPACE_ID PATH --token TOKEN --hunk INDEX [--staged yes|no]
                                        Capture one hunk of a git diff read with that token
  context terminal CONVERSATION_ID REQUEST_ID WORKSPACE_ID TERMINAL_ID [--first-row ROW] < TEXT
  context log CONVERSATION_ID REQUEST_ID WORKSPACE_ID SERVICE --lines COUNT < TEXT
                                        Capture terminal or service output read from stdin
  context browser CONVERSATION_ID REQUEST_ID CAPTURE_ID
                                        Record a finished browser capture as a context node
  context get CONVERSATION_ID NODE_ID   Show a context node and whether its attachments remain
  context plan CONVERSATION_ID [--attachments JSON_ARRAY] [--text TEXT]
                                        Show how the provider receives each attachment, and what it refuses
`

const CLIENT_TEXT_LIMIT = 1024 * 1024

function count(value: string, label: string): number {
  if (!/^\d{1,9}$/.test(value)) throw new CliError('usage', `${label} must be a whole number.`)
  return Number(value)
}

async function stdinText(): Promise<string> {
  if (process.stdin.isTTY) throw new CliError('usage', 'Pipe the captured text on stdin.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > CLIENT_TEXT_LIMIT) throw new CliError('usage', 'Captured text exceeds 1 MiB; select less.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Context capture, inspection and provider plans. Each capture names its node with REQUEST_ID. */
export async function runContextCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'context') return undefined
  const capture = (conversation: string | undefined, request: string | undefined, source: Record<string, unknown>) =>
    dailyUseCommand(socketPath, {
      op: 'context.capture',
      conversation_id: required(conversation, 'CONVERSATION_ID'),
      request_id: required(request, 'REQUEST_ID'),
      source: source as never,
    })
  const [conversation, request, workspace, target, ...options] = rest
  if (action === 'file') {
    const named = namedOptions(options, ['--lines'], 'context file')
    const range = /^(\d{1,9})-(\d{1,9})$/.exec(required(named['--lines'], '--lines'))
    if (!range) throw new CliError('usage', '--lines takes START-END, such as 10-40.')
    return capture(conversation, request, {
      kind: 'file_range',
      workspace_id: required(workspace, 'WORKSPACE_ID'),
      path: required(target, 'PATH'),
      start_line: Number(range[1]),
      end_line: Number(range[2]),
    })
  }
  if (action === 'hunk') {
    const named = namedOptions(options, ['--token', '--hunk', '--staged'], 'context hunk')
    const staged = named['--staged'] ?? 'no'
    if (staged !== 'yes' && staged !== 'no') throw new CliError('usage', '--staged takes yes or no.')
    return capture(conversation, request, {
      kind: 'diff_hunk',
      workspace_id: required(workspace, 'WORKSPACE_ID'),
      path: required(target, 'PATH'),
      staged: staged === 'yes',
      token: required(named['--token'], '--token'),
      hunk: count(required(named['--hunk'], '--hunk'), '--hunk'),
    })
  }
  if (action === 'terminal') {
    const named = namedOptions(options, ['--first-row'], 'context terminal')
    return capture(conversation, request, {
      kind: 'terminal_output',
      workspace_id: required(workspace, 'WORKSPACE_ID'),
      terminal_id: required(target, 'TERMINAL_ID'),
      text: await stdinText(),
      ...(named['--first-row'] !== undefined ? { first_row: count(named['--first-row'], '--first-row') } : {}),
    })
  }
  if (action === 'log') {
    const named = namedOptions(options, ['--lines'], 'context log')
    return capture(conversation, request, {
      kind: 'service_log',
      workspace_id: required(workspace, 'WORKSPACE_ID'),
      service: required(target, 'SERVICE'),
      lines: count(required(named['--lines'], '--lines'), '--lines'),
      text: await stdinText(),
    })
  }
  if (action === 'browser') {
    if (rest.length !== 3)
      throw new CliError('usage', 'context browser requires CONVERSATION_ID REQUEST_ID CAPTURE_ID.')
    return capture(conversation, request, { kind: 'browser_capture', capture_id: required(workspace, 'CAPTURE_ID') })
  }
  if (action === 'get') {
    if (rest.length !== 2) throw new CliError('usage', 'context get requires CONVERSATION_ID NODE_ID.')
    return dailyUseCommand(socketPath, {
      op: 'context.get',
      conversation_id: required(conversation, 'CONVERSATION_ID'),
      node_id: required(request, 'NODE_ID'),
    })
  }
  if (action === 'plan') {
    const named = namedOptions(rest.slice(1), ['--attachments', '--text'], 'context plan')
    let attachments: unknown = []
    if (named['--attachments'] !== undefined) {
      try {
        attachments = JSON.parse(named['--attachments'])
      } catch {
        throw new CliError('usage', '--attachments must be valid JSON.')
      }
    }
    if (!Array.isArray(attachments)) throw new CliError('usage', '--attachments must be a JSON array.')
    return dailyUseCommand(socketPath, {
      op: 'context.plan',
      conversation_id: required(conversation, 'CONVERSATION_ID'),
      text: named['--text'] ?? '',
      attachments: attachments as never,
    })
  }
  return undefined
}
