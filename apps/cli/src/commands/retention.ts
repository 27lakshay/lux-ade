import { dailyUseCommand } from '@ade/client'
import { required, type CommandResult } from '../shared.js'

export const retentionUsage = `  retention preview                     List what retention would remove now, with its generation
  retention apply GENERATION            Remove exactly the previewed set; a changed set is refused
`

export async function runRetentionCommand(socketPath: string, area: string | undefined, action: string | undefined,
  rest: string[]): Promise<CommandResult | undefined> {
  if (area !== 'retention') return undefined
  if (action === 'preview' && rest.length === 0) {
    return dailyUseCommand(socketPath, { op: 'retention.preview' })
  }
  if (action === 'apply' && rest.length === 1) {
    return dailyUseCommand(socketPath, { op: 'retention.apply', generation: required(rest[0], 'GENERATION') })
  }
  return undefined
}
