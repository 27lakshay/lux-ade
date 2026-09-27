import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const draftUsage = `  draft history CONVERSATION_ID [--window ID] [--before ENTRY_ID] [--limit N]
                                        List recalled sent and discarded drafts, newest first
  draft recall CONVERSATION_ID ENTRY_ID --window ID --expected-revision N --revision N
                                        Restore a recalled draft if the window draft is still at N
  draft stash save CONVERSATION_ID NAME --window ID --text TEXT [--expected-revision N]
                                        Keep a draft under NAME; replacing one needs its revision
  draft stash list CONVERSATION_ID      List the Conversation's stashes, most recent first
  draft stash restore CONVERSATION_ID NAME --window ID --stash-revision N --expected-revision N --revision N
                                        Restore a stash if the window draft is still at N
  draft stash drop CONVERSATION_ID NAME --stash-revision N
                                        Delete a stash at the revision you listed
`

function integer(value: string | undefined, label: string): number {
  const text = required(value, label)
  if (!/^(0|[1-9][0-9]{0,15})$/.test(text)) throw new CliError('usage', `${label} must be a non-negative integer.`)
  return Number(text)
}

function split(
  rest: string[],
  positional: number,
  allowed: readonly string[],
  command: string,
): { args: string[]; options: Record<string, string> } {
  if (rest.length < positional || rest.slice(0, positional).some((word) => word.startsWith('--'))) {
    throw new CliError('usage', `draft ${command} is missing arguments. Run ade --help for usage.`)
  }
  return { args: rest.slice(0, positional), options: namedOptions(rest.slice(positional), allowed, `draft ${command}`) }
}

/** A restore that wrote nothing fails the command; the reply names the current draft. */
function applied<T extends { outcome: string; draft: { revision: number } }>(reply: T): T {
  if (reply.outcome === 'conflict') {
    throw new CliError(
      'not_applied',
      `The window draft moved to revision ${reply.draft.revision}; review it and restore again with that revision.`,
    )
  }
  return reply
}

export async function runDraftCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area !== 'draft') return undefined
  if (action === 'history') {
    const { args, options } = split(rest, 1, ['--window', '--before', '--limit'], 'history')
    return dailyUseCommand(socketPath, {
      op: 'draft.history.list',
      conversation_id: args[0],
      ...(options['--window'] ? { window_id: options['--window'] } : {}),
      ...(options['--before'] ? { before: integer(options['--before'], '--before') } : {}),
      ...(options['--limit'] ? { limit: integer(options['--limit'], '--limit') } : {}),
    })
  }
  if (action === 'recall') {
    const { args, options } = split(rest, 2, ['--window', '--expected-revision', '--revision'], 'recall')
    return applied(
      await dailyUseCommand<'draft.history.restore'>(socketPath, {
        op: 'draft.history.restore',
        conversation_id: args[0],
        entry_id: integer(args[1], 'ENTRY_ID'),
        window_id: required(options['--window'], '--window'),
        expected_revision: integer(options['--expected-revision'], '--expected-revision'),
        revision: integer(options['--revision'], '--revision'),
      }),
    )
  }
  if (action !== 'stash') return undefined
  const [verb, ...words] = rest
  if (verb === 'save') {
    const { args, options } = split(words, 2, ['--window', '--text', '--expected-revision'], 'stash save')
    return dailyUseCommand(socketPath, {
      op: 'draft.stash.save',
      conversation_id: args[0],
      name: args[1],
      window_id: required(options['--window'], '--window'),
      text: required(options['--text'], '--text'),
      ...(options['--expected-revision']
        ? { expected_revision: integer(options['--expected-revision'], '--expected-revision') }
        : {}),
    })
  }
  if (verb === 'list') {
    const { args } = split(words, 1, [], 'stash list')
    return dailyUseCommand(socketPath, { op: 'draft.stash.list', conversation_id: args[0] })
  }
  if (verb === 'restore') {
    const { args, options } = split(
      words,
      2,
      ['--window', '--stash-revision', '--expected-revision', '--revision'],
      'stash restore',
    )
    return applied(
      await dailyUseCommand<'draft.stash.restore'>(socketPath, {
        op: 'draft.stash.restore',
        conversation_id: args[0],
        name: args[1],
        window_id: required(options['--window'], '--window'),
        stash_revision: integer(options['--stash-revision'], '--stash-revision'),
        expected_revision: integer(options['--expected-revision'], '--expected-revision'),
        revision: integer(options['--revision'], '--revision'),
      }),
    )
  }
  if (verb === 'drop') {
    const { args, options } = split(words, 2, ['--stash-revision'], 'stash drop')
    return dailyUseCommand(socketPath, {
      op: 'draft.stash.drop',
      conversation_id: args[0],
      name: args[1],
      stash_revision: integer(options['--stash-revision'], '--stash-revision'),
    })
  }
  throw new CliError('usage', 'draft stash takes save, list, restore or drop. Run ade --help for usage.')
}
