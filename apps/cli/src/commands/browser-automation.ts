import { dailyUseCommand } from '@ade/client'
import { CliError, namedOptions, required, type CommandResult } from '../shared.js'

export const browserAutomationUsage = `  browser click OWNER_ID TAB_ID --selector CSS --request-id ID [--timeout-ms MS]
                                        Click an element of one exact tab (an effect; inspect with browser operation)
  browser type OWNER_ID TAB_ID --selector CSS --text TEXT --request-id ID [--replace yes|no] [--timeout-ms MS]
                                        Type into an editable element of one exact tab
  browser evaluate OWNER_ID TAB_ID EXPRESSION [--timeout-ms MS]
                                        Evaluate a read-only expression; side effects are refused
  browser wait OWNER_ID TAB_ID --selector CSS [--state attached|visible|detached|hidden] [--timeout-ms MS]
  browser screenshot OWNER_ID TAB_ID    Capture the visible viewport of one exact tab
`

const waitStates = ['attached', 'visible', 'detached', 'hidden'] as const
type WaitState = typeof waitStates[number]

function milliseconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d{1,6}$/.test(value)) throw new CliError('usage', '--timeout-ms takes a whole number of milliseconds.')
  return Number(value)
}

function yesNo(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined
  if (value !== 'yes' && value !== 'no') throw new CliError('usage', `${flag} takes yes or no.`)
  return value === 'yes'
}

/** Click, type, evaluate, wait and screenshot. Each names its owner and tab; none follows focus. */
export async function runBrowserAutomationCommand(socketPath: string, profileId: () => Promise<string>,
  action: string, rest: string[]): Promise<CommandResult | undefined> {
  const command = `browser ${action}`
  if (rest.length < 2) throw new CliError('usage', `${command} requires OWNER_ID TAB_ID.`)
  const target = async () => ({ profile_id: await profileId(), owner_id: required(rest[0], 'OWNER_ID'),
    tab_id: required(rest[1], 'TAB_ID') })
  const words = rest.slice(2)
  const timeout = (options: Record<string, string>) => {
    const ms = milliseconds(options['--timeout-ms'])
    return ms === undefined ? {} : { timeout_ms: ms }
  }
  if (action === 'click' || action === 'type') {
    const flags = action === 'click' ? ['--selector', '--request-id', '--timeout-ms']
      : ['--selector', '--text', '--request-id', '--replace', '--timeout-ms']
    const options = namedOptions(words, flags, command)
    const operationId = required(options['--request-id'], '--request-id')
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(operationId)) throw new CliError('usage', '--request-id takes 1 to 256 letters, digits, - or _.')
    const selector = required(options['--selector'], '--selector')
    if (action === 'click') {
      return dailyUseCommand(socketPath, { op: 'browser.click', ...(await target()), operation_id: operationId,
        selector, ...timeout(options) })
    }
    const replace = yesNo(options['--replace'], '--replace')
    return dailyUseCommand(socketPath, { op: 'browser.type', ...(await target()), operation_id: operationId,
      selector, text: required(options['--text'], '--text'), ...(replace === undefined ? {} : { replace }),
      ...timeout(options) })
  }
  if (action === 'evaluate') {
    const expression = required(words[0], 'EXPRESSION')
    const options = namedOptions(words.slice(1), ['--timeout-ms'], command)
    return dailyUseCommand(socketPath, { op: 'browser.evaluate', ...(await target()), expression, ...timeout(options) })
  }
  if (action === 'wait') {
    const options = namedOptions(words, ['--selector', '--state', '--timeout-ms'], command)
    const state = options['--state']
    if (state !== undefined && !waitStates.includes(state as WaitState)) {
      throw new CliError('usage', `--state takes ${waitStates.join(', ')}.`)
    }
    return dailyUseCommand(socketPath, { op: 'browser.wait', ...(await target()),
      selector: required(options['--selector'], '--selector'),
      ...(state === undefined ? {} : { state: state as WaitState }), ...timeout(options) })
  }
  if (action === 'screenshot') {
    if (words.length) throw new CliError('usage', 'browser screenshot requires only OWNER_ID TAB_ID.')
    return dailyUseCommand(socketPath, { op: 'browser.screenshot', ...(await target()) })
  }
  return undefined
}
