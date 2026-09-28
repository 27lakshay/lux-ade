import { randomUUID } from 'node:crypto'
import { call, type CallRequest } from '@ade/client'
import { boundedInteger, CliError, jsonObject, parseWords, positionals, type CommandResult } from '../shared.js'

// Windows, layouts, tabs and panes: every command is one daemon operation, so
// the CLI rearranges a window by the same rules as the desktop.

type LayoutAction = CallRequest<'layout.apply'>['action']
type TabTarget = Extract<LayoutAction, { type: 'open_tab' }>['tab']['target']
type Layout = CallRequest<'layout.replace'>['layout']

export const layoutUsage = `  window list                           List windows, open and closed
  window create WORKSPACE_ID [--id WINDOW_ID]
                                        Open a window on a workspace; reuse the ID to retry
  window close WINDOW_ID                Close a window; its layouts stay for window reopen
  window reopen WINDOW_ID               Show a closed window again, as it was
  window show WINDOW_ID WORKSPACE_ID    Show another workspace in the window
  window bounds WINDOW_ID X Y WIDTH HEIGHT
                                        Record the window's position and size
  window collapse WINDOW_ID [PROJECT_ID...]
                                        Set the projects the navigator shows collapsed
  layout get [--window ID] [--workspace ID]
                                        Read a window's panes and tabs for a workspace
  layout apply --action JSON [--window ID] [--workspace ID] [--expected-revision N]
                                        Apply one layout action; a stale revision is refused
  layout replace --layout JSON [--window ID] [--workspace ID] [--expected-revision N]
                                        Store a whole layout
  tab open KIND [ID|PATH] [--pane PANE_ID] [--id TAB_ID] [--staged] [--window ID] [--workspace ID]
                                        Open a tab: conversation, terminal or browser ID,
                                        file or diff PATH, or new_conversation
  tab close TAB_ID [--window ID] [--workspace ID]
  pane split PANE_ID --direction row|column [--id PANE_ID] [--window ID] [--workspace ID]
Layout commands without --window act on the only open window.
`

const TARGET_OPTIONS = ['--window', '--workspace'] as const

/** The window a layout command names, or the only open window. */
async function windowId(socketPath: string, named: string | undefined): Promise<string> {
  if (named) return named
  const { windows } = await call(socketPath, 'window.list', {})
  const open = windows.filter((window) => window.state === 'open')
  if (open.length !== 1) {
    throw new CliError('usage', `${open.length} windows are open; name one with --window ID.`)
  }
  return open[0]!.id
}

async function target(socketPath: string, options: Record<string, string>) {
  return {
    window_id: await windowId(socketPath, options['--window']),
    ...(options['--workspace'] ? { workspace_id: options['--workspace'] } : {}),
  }
}

function expectedRevision(options: Record<string, string>) {
  const value = options['--expected-revision']
  return value === undefined
    ? {}
    : { expected_revision: boundedInteger(value, '--expected-revision', 0, Number.MAX_SAFE_INTEGER) }
}

async function apply(socketPath: string, options: Record<string, string>, action: LayoutAction) {
  return call(socketPath, 'layout.apply', { ...(await target(socketPath, options)), action })
}

function tabTarget(kind: string | undefined, value: string | undefined, staged: boolean): TabTarget {
  const needs = (label: string): string => {
    if (!value) throw new CliError('usage', `tab open ${kind} requires ${label}.`)
    return value
  }
  switch (kind) {
    case 'conversation':
      return { kind: 'conversation', id: needs('an ID') }
    case 'terminal':
      return { kind: 'terminal', id: needs('an ID') }
    case 'browser':
      return { kind: 'browser', id: needs('an ID') }
    case 'file':
      return { kind: 'file', path: needs('a PATH') }
    case 'diff':
      return { kind: 'diff', path: needs('a PATH'), staged }
    case 'new_conversation':
      if (value) throw new CliError('usage', 'tab open new_conversation takes no ID.')
      return { kind: 'new_conversation' }
    default:
      throw new CliError('usage', 'tab open KIND is conversation, terminal, browser, file, diff or new_conversation.')
  }
}

export async function runLayoutCommand(
  socketPath: string,
  area: string | undefined,
  action: string | undefined,
  rest: string[],
): Promise<CommandResult | undefined> {
  if (area === 'window') {
    if (action === 'list') {
      positionals(parseWords(rest, [], [], 'window list'), 0, 'window list takes no arguments')
      return call(socketPath, 'window.list', {})
    }
    if (action === 'create') {
      const parsed = parseWords(rest, ['--id'], [], 'window create')
      const [workspaceId] = positionals(parsed, 1, 'window create requires WORKSPACE_ID')
      return call(socketPath, 'window.create', {
        window_id: parsed.options['--id'] ?? `window-${randomUUID()}`,
        workspace_id: workspaceId!,
      })
    }
    if (action === 'close' || action === 'reopen') {
      const [id] = positionals(parseWords(rest, [], [], `window ${action}`), 1, `window ${action} requires WINDOW_ID`)
      return action === 'close'
        ? call(socketPath, 'window.close', { window_id: id! })
        : call(socketPath, 'window.reopen', { window_id: id! })
    }
    if (action === 'show') {
      const [id, workspaceId] = positionals(
        parseWords(rest, [], [], 'window show'),
        2,
        'window show requires WINDOW_ID WORKSPACE_ID',
      )
      return call(socketPath, 'window.show_workspace', { window_id: id!, workspace_id: workspaceId! })
    }
    if (action === 'bounds') {
      const [id, ...numbers] = positionals(
        parseWords(rest, [], [], 'window bounds'),
        5,
        'window bounds requires WINDOW_ID X Y WIDTH HEIGHT',
      )
      const [x, y, width, height] = numbers.map((value) => {
        const number = Number(value)
        if (!Number.isFinite(number)) throw new CliError('usage', 'Window bounds must be numbers.')
        return number
      })
      return call(socketPath, 'window.set_bounds', {
        window_id: id!,
        bounds: { x: x!, y: y!, width: width!, height: height! },
      })
    }
    if (action === 'collapse') {
      const parsed = parseWords(rest, [], [], 'window collapse')
      const [id, ...projects] = parsed.positionals
      if (!id) throw new CliError('usage', 'window collapse requires WINDOW_ID.')
      return call(socketPath, 'window.set_view_state', { window_id: id, collapsed_projects: projects })
    }
    return undefined
  }
  if (area === 'layout') {
    if (action === 'get') {
      const parsed = parseWords(rest, TARGET_OPTIONS, [], 'layout get')
      positionals(parsed, 0, 'layout get takes only options')
      return call(socketPath, 'layout.get', await target(socketPath, parsed.options))
    }
    if (action === 'apply' || action === 'replace') {
      const option = action === 'apply' ? '--action' : '--layout'
      const parsed = parseWords(rest, [...TARGET_OPTIONS, option, '--expected-revision'], [], `layout ${action}`)
      positionals(parsed, 0, `layout ${action} requires ${option} JSON`)
      const value = jsonObject(parsed.options[option], option)
      const fields = { ...(await target(socketPath, parsed.options)), ...expectedRevision(parsed.options) }
      return action === 'apply'
        ? call(socketPath, 'layout.apply', { ...fields, action: value as unknown as LayoutAction })
        : call(socketPath, 'layout.replace', { ...fields, layout: value as unknown as Layout })
    }
    return undefined
  }
  if (area === 'tab' && action === 'open') {
    const parsed = parseWords(rest, [...TARGET_OPTIONS, '--pane', '--id'], ['--staged'], 'tab open')
    const [kind, value, extra] = parsed.positionals
    if (extra !== undefined) throw new CliError('usage', 'tab open takes KIND and at most one ID or PATH.')
    const tab = {
      id: parsed.options['--id'] ?? `tab-${randomUUID()}`,
      target: tabTarget(kind, value, parsed.flags.has('--staged')),
    }
    return apply(socketPath, parsed.options, {
      type: 'open_tab',
      tab,
      ...(parsed.options['--pane'] ? { pane_id: parsed.options['--pane'] } : {}),
    })
  }
  if (area === 'tab' && action === 'close') {
    const parsed = parseWords(rest, TARGET_OPTIONS, [], 'tab close')
    const [tabId] = positionals(parsed, 1, 'tab close requires TAB_ID')
    return apply(socketPath, parsed.options, { type: 'close_tab', tab_id: tabId! })
  }
  if (area === 'pane' && action === 'split') {
    const parsed = parseWords(rest, [...TARGET_OPTIONS, '--direction', '--id'], [], 'pane split')
    const [paneId] = positionals(parsed, 1, 'pane split requires PANE_ID --direction row|column')
    const direction = parsed.options['--direction']
    if (direction !== 'row' && direction !== 'column') {
      throw new CliError('usage', 'pane split requires --direction row or column.')
    }
    return apply(socketPath, parsed.options, {
      type: 'split_pane',
      pane_id: paneId!,
      direction,
      new_pane_id: parsed.options['--id'] ?? `pane-${randomUUID()}`,
    })
  }
  return undefined
}
