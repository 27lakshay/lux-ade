import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const browserDiagnosticsUsage = `  browser diagnostics attach OWNER_ID TAB_ID
                                        Capture redacted console and network summaries for one exact tab
  browser diagnostics detach OWNER_ID TAB_ID
  browser diagnostics read OWNER_ID TAB_ID [--after SEQ] [--limit N]
  browser recording start OWNER_ID TAB_ID RECORDING_ID --capture KIND[,KIND...]
      [--interval-ms N] [--max-duration-ms N]
                                        Record screenshots, page_events, console or network locally
  browser recording stop OWNER_ID RECORDING_ID
  browser recording get OWNER_ID RECORDING_ID
`

const captureKinds = ['screenshots', 'page_events', 'console', 'network'] as const
type CaptureKind = (typeof captureKinds)[number]

function whole(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d{1,15}$/.test(value)) throw new CliError('usage', `${label} must be a whole number.`)
  return Number(value)
}

/** Diagnostics and recording commands. Each names its tab or recording; none follows focus. */
export async function runBrowserDiagnosticsCommand(
  socketPath: string,
  profileId: () => Promise<string>,
  area: string,
  rest: string[],
): Promise<CommandResult | undefined> {
  const [action, ...words] = rest
  if (area === 'diagnostics' && (action === 'attach' || action === 'detach')) {
    if (words.length !== 2) throw new CliError('usage', `browser diagnostics ${action} requires OWNER_ID TAB_ID.`)
    const target = {
      profile_id: await profileId(),
      owner_id: required(words[0], 'OWNER_ID'),
      tab_id: required(words[1], 'TAB_ID'),
    }
    return action === 'attach'
      ? dailyUseCommand(socketPath, { op: 'browser.diagnostics.attach', ...target })
      : dailyUseCommand(socketPath, { op: 'browser.diagnostics.detach', ...target })
  }
  if (area === 'diagnostics' && action === 'read') {
    if (words.length < 2) throw new CliError('usage', 'browser diagnostics read requires OWNER_ID TAB_ID.')
    const options = namedOptions(words.slice(2), ['--after', '--limit'], 'browser diagnostics read')
    const after = whole(options['--after'], '--after')
    const limit = whole(options['--limit'], '--limit')
    return dailyUseCommand(socketPath, {
      op: 'browser.diagnostics.read',
      profile_id: await profileId(),
      owner_id: required(words[0], 'OWNER_ID'),
      tab_id: required(words[1], 'TAB_ID'),
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    })
  }
  if (area === 'recording' && action === 'start') {
    if (words.length < 3) throw new CliError('usage', 'browser recording start requires OWNER_ID TAB_ID RECORDING_ID.')
    const options = namedOptions(
      words.slice(3),
      ['--capture', '--interval-ms', '--max-duration-ms'],
      'browser recording start',
    )
    const capture = required(options['--capture'], '--capture').split(',')
    if (capture.some((kind) => !captureKinds.includes(kind as CaptureKind))) {
      throw new CliError('usage', `--capture takes ${captureKinds.join(', ')}.`)
    }
    const interval = whole(options['--interval-ms'], '--interval-ms')
    const duration = whole(options['--max-duration-ms'], '--max-duration-ms')
    return dailyUseCommand(socketPath, {
      op: 'browser.recording.start',
      profile_id: await profileId(),
      owner_id: required(words[0], 'OWNER_ID'),
      tab_id: required(words[1], 'TAB_ID'),
      recording_id: required(words[2], 'RECORDING_ID'),
      capture: capture as CaptureKind[],
      ...(interval === undefined ? {} : { interval_ms: interval }),
      ...(duration === undefined ? {} : { max_duration_ms: duration }),
    })
  }
  if (area === 'recording' && (action === 'stop' || action === 'get')) {
    if (words.length !== 2) throw new CliError('usage', `browser recording ${action} requires OWNER_ID RECORDING_ID.`)
    const target = {
      profile_id: await profileId(),
      owner_id: required(words[0], 'OWNER_ID'),
      recording_id: required(words[1], 'RECORDING_ID'),
    }
    return action === 'stop'
      ? dailyUseCommand(socketPath, { op: 'browser.recording.stop', ...target })
      : dailyUseCommand(socketPath, { op: 'browser.recording.get', ...target })
  }
  return undefined
}
