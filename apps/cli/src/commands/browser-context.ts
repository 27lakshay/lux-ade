import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const browserContextUsage = `  browser partition list                List the profile's browser partitions
  browser partition create PARTITION_ID NAME
                                        Register a named browser partition with its own storage
  browser import preview chrome|safari [--source-profile NAME]
                                        Show what an import would read and what it refuses
  browser import run IMPORT_ID chrome|safari --classes bookmarks[,history]
      [--partition PARTITION_ID] [--source-profile NAME]
  browser import get IMPORT_ID
  browser capture OWNER_ID TAB_ID CONVERSATION_ID CAPTURE_ID --selector CSS [--screenshot yes|no]
                                        Attach one element's HTML, styles and screenshot to a conversation
`

const sources = ['chrome', 'safari'] as const
type Source = (typeof sources)[number]
const classes = ['bookmarks', 'history'] as const
type ImportClass = (typeof classes)[number]

function source(value: string | undefined): Source {
  if (!sources.includes(value as Source)) throw new CliError('usage', 'The import source is chrome or safari.')
  return value as Source
}

/** Partition, import and capture commands. A capture names its tab; none follows focus. */
export async function runBrowserContextCommand(
  socketPath: string,
  profileId: () => Promise<string>,
  area: string,
  rest: string[],
): Promise<CommandResult | undefined> {
  const [action, ...words] = rest
  if (area === 'partition' && action === 'list') {
    if (words.length) throw new CliError('usage', 'browser partition list does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'browser.partition.list' })
  }
  if (area === 'partition' && action === 'create') {
    if (words.length !== 2) throw new CliError('usage', 'browser partition create requires PARTITION_ID NAME.')
    return dailyUseCommand(socketPath, {
      op: 'browser.partition.create',
      partition_id: required(words[0], 'PARTITION_ID'),
      name: required(words[1], 'NAME'),
    })
  }
  if (area === 'import' && action === 'preview') {
    const options = namedOptions(words.slice(1), ['--source-profile'], 'browser import preview')
    return dailyUseCommand(socketPath, {
      op: 'browser.import.preview',
      source: source(words[0]),
      ...(options['--source-profile'] ? { source_profile: options['--source-profile'] } : {}),
    })
  }
  if (area === 'import' && action === 'run') {
    if (words.length < 2) throw new CliError('usage', 'browser import run requires IMPORT_ID and a source.')
    const options = namedOptions(words.slice(2), ['--classes', '--partition', '--source-profile'], 'browser import run')
    const wanted = required(options['--classes'], '--classes').split(',')
    if (wanted.some((name) => !classes.includes(name as ImportClass))) {
      throw new CliError('usage', `--classes takes ${classes.join(', ')}.`)
    }
    return dailyUseCommand(socketPath, {
      op: 'browser.import.run',
      import_id: required(words[0], 'IMPORT_ID'),
      source: source(words[1]),
      classes: wanted as ImportClass[],
      partition_id: options['--partition'] ?? 'default',
      ...(options['--source-profile'] ? { source_profile: options['--source-profile'] } : {}),
    })
  }
  if (area === 'import' && action === 'get') {
    if (words.length !== 1) throw new CliError('usage', 'browser import get requires IMPORT_ID.')
    return dailyUseCommand(socketPath, { op: 'browser.import.get', import_id: required(words[0], 'IMPORT_ID') })
  }
  if (area === 'capture') {
    const all = [action, ...words].filter((word): word is string => word !== undefined)
    if (all.length < 4)
      throw new CliError('usage', 'browser capture requires OWNER_ID TAB_ID CONVERSATION_ID CAPTURE_ID.')
    const options = namedOptions(all.slice(4), ['--selector', '--screenshot'], 'browser capture')
    const screenshot = options['--screenshot'] ?? 'yes'
    if (screenshot !== 'yes' && screenshot !== 'no') throw new CliError('usage', '--screenshot takes yes or no.')
    return dailyUseCommand(socketPath, {
      op: 'browser.context.capture',
      profile_id: await profileId(),
      owner_id: required(all[0], 'OWNER_ID'),
      tab_id: required(all[1], 'TAB_ID'),
      conversation_id: required(all[2], 'CONVERSATION_ID'),
      capture_id: required(all[3], 'CAPTURE_ID'),
      selector: required(options['--selector'], '--selector'),
      screenshot: screenshot === 'yes',
    })
  }
  return undefined
}
