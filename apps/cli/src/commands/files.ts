import { call } from '@ade/client'
import { boundedInteger, CliError, parseWords, positionals, type CommandResult } from '../shared.js'

export const fileUsage = `  file list WORKSPACE_ID [PATH] [--cursor CURSOR] [--limit 1..100]
                                        List one page of a workspace directory
  file search WORKSPACE_ID QUERY [--cursor CURSOR] [--limit 1..100]
                                        Find entries whose name contains QUERY, ignoring case
  file preview WORKSPACE_ID PATH        Read the bounded contents of one workspace file
`

function page(options: Record<string, string>): { cursor?: string; limit?: number } {
  return {
    ...(options['--cursor'] === undefined ? {} : { cursor: options['--cursor'] }),
    ...(options['--limit'] === undefined ? {} : { limit: boundedInteger(options['--limit'], 'LIMIT', 1, 100) }),
  }
}

export async function runFileCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'file') return undefined
  if (action === 'list') {
    const parsed = parseWords(rest, ['--cursor', '--limit'], [], 'file list')
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2 || !parsed.positionals[0]) {
      throw new CliError('usage', 'file list requires WORKSPACE_ID [PATH].')
    }
    const [workspace_id, path] = parsed.positionals
    return call(socketPath, 'file.list', { workspace_id, ...(path ? { path } : {}), ...page(parsed.options) })
  }
  if (action === 'search') {
    const parsed = parseWords(rest, ['--cursor', '--limit'], [], 'file search')
    const [workspace_id, query] = positionals(parsed, 2, 'file search requires WORKSPACE_ID QUERY')
    return call(socketPath, 'file.search', { workspace_id, query, ...page(parsed.options) })
  }
  if (action === 'preview') {
    const [workspace_id, path] = positionals(parseWords(rest, [], [], 'file preview'), 2,
      'file preview requires WORKSPACE_ID PATH')
    return call(socketPath, 'file.preview', { workspace_id, path })
  }
  return undefined
}
