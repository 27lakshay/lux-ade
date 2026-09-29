import { handle } from './ipc'
import { dailyUseCommand, type DailyUseRequest } from '@ade/client'
import { fileOperations, isAllowedOperation, type FileOperation } from '../shared/bridge/operations'
import { activeReviewContext, assertReviewContext } from './review'

export function registerFileIpc(): void {
  handle('ade:file-request', async (event, op: unknown, fields: unknown) => {
    if (!isAllowedOperation(fileOperations, op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('Invalid file request')
    }
    const args = fields as Record<string, unknown>
    const context = activeReviewContext(event.sender.id, args.workspace_id)
    const workspaceId = args.workspace_id as string
    // The SDK checks the request against its contract; the daemon checks paths (relative, no
    // traversal), the query and the page limit.
    // A listing with no path is the workspace's root; a page holds 100 entries unless asked.
    const request: Record<string, unknown> =
      op === 'file.preview' ? { ...args } : { ...(op === 'file.list' ? { path: '' } : {}), limit: 100, ...args }
    const response = await dailyUseCommand(context.endpoint, { ...request, op } as DailyUseRequest<FileOperation>)
    assertReviewContext(context, workspaceId)
    if (JSON.stringify(response).length > 1_000_000) throw new Error('File result exceeds the display limit')
    const expectedType = op.replace('.', '_')
    if (response.type !== expectedType) throw new Error('Invalid file response')
    return response
  })
}
