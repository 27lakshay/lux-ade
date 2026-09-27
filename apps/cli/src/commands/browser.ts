import { dailyUseCommand } from '@ade/client'
import { CliError, required, type CommandResult } from '../shared.js'

export const browserUsage = `  browser owner                         Inspect the selected profile's live browser owner
  browser list OWNER_ID                 List tabs under that exact owner
  browser inspect OWNER_ID TAB_ID       Inspect one exact browser tab
  browser open OWNER_ID URL --request-id ID
  browser navigate OWNER_ID TAB_ID URL --request-id ID
  browser close OWNER_ID TAB_ID --request-id ID
  browser operation REQUEST_ID          Inspect a browser mutation receipt
`

export async function runBrowserCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area === 'browser' && action === 'owner') {
    if (rest.length) throw new CliError('usage', 'browser owner does not accept arguments.')
    return dailyUseCommand(socketPath, { op: 'browser.owner.get' })
  }
  if (area === 'browser' && (action === 'list' || action === 'inspect')) {
    const count = action === 'inspect' ? 2 : 1
    if (rest.length !== count) throw new CliError('usage', `browser ${action} requires OWNER_ID${count === 2 ? ' TAB_ID' : ''}.`)
    const profileId = await browserProfile(socketPath)
    const ownerId = required(rest[0], 'OWNER_ID')
    if (action === 'list') return dailyUseCommand(socketPath, { op: 'browser.list', profile_id: profileId, owner_id: ownerId })
    return dailyUseCommand(socketPath, { op: 'browser.inspect', profile_id: profileId, owner_id: ownerId,
      tab_id: required(rest[1], 'TAB_ID') })
  }
  if (area === 'browser' && action === 'operation') {
    if (rest.length !== 1) throw new CliError('usage', 'browser operation requires REQUEST_ID.')
    return dailyUseCommand(socketPath, { op: 'browser.operation', operation_id: required(rest[0], 'REQUEST_ID') })
  }
  if (area === 'browser' && (action === 'open' || action === 'navigate' || action === 'close')) {
    const positionalCount = action === 'open' ? 2 : action === 'navigate' ? 3 : 2
    if (rest.length !== positionalCount + 2 || rest[positionalCount] !== '--request-id' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(rest[positionalCount + 1] ?? '')) {
      throw new CliError('usage', `browser ${action} requires OWNER_ID${action === 'open' ? ' URL' :
        action === 'navigate' ? ' TAB_ID URL' : ' TAB_ID'} --request-id ID.`)
    }
    const profileId = await browserProfile(socketPath)
    const target = { profile_id: profileId, owner_id: required(rest[0], 'OWNER_ID'),
      operation_id: rest[positionalCount + 1] }
    if (action === 'open') return dailyUseCommand(socketPath, { op: 'browser.open', ...target, url: required(rest[1], 'URL') })
    if (action === 'navigate') {
      return dailyUseCommand(socketPath, { op: 'browser.navigate', ...target, tab_id: required(rest[1], 'TAB_ID'),
        url: required(rest[2], 'URL') })
    }
    return dailyUseCommand(socketPath, { op: 'browser.close', ...target, tab_id: required(rest[1], 'TAB_ID') })
  }
  return undefined
}

async function browserProfile(socketPath: string): Promise<string> {
  const owner = await dailyUseCommand<'browser.owner.get'>(socketPath, { op: 'browser.owner.get' })
  if (!owner.profile_id) throw new CliError('protocol', 'Browser owner has no profile identity.')
  return owner.profile_id
}
