import { ipcMain } from 'electron'
import { dailyUseCommand, type DailyUseRequest } from '@ade/client'
import { activeReviewContext, assertReviewContext, reviewPath } from './review'

type FileOp = 'file.list' | 'file.search' | 'file.preview'
const fileOps = new Set<string>(['file.list', 'file.search', 'file.preview'])
export function registerFileIpc(): void {
  ipcMain.handle('ade:file-request', async (event, op: unknown, fields: unknown) => {
    if (typeof op !== 'string' || !fileOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('Invalid file request')
    }
    const args = fields as Record<string, unknown>
    const context = activeReviewContext(event.sender.id, args.workspace_id)
    const workspaceId = args.workspace_id as string
    const request: Record<string, unknown> = { workspace_id: workspaceId }
    if (op === 'file.list' || op === 'file.preview') {
      if (op === 'file.list' && (args.path === undefined || args.path === '')) request.path = ''
      else if (!reviewPath(args.path)) throw new Error('Invalid relative file path')
      else request.path = args.path
    }
    if (op === 'file.search') {
      if (
        typeof args.query !== 'string' ||
        !args.query.trim() ||
        args.query.length > 256 ||
        args.query.includes('\0')
      ) {
        throw new Error('Invalid file search')
      }
      request.query = args.query.trim()
    }
    if (op !== 'file.preview') {
      if (args.cursor !== undefined) {
        if (typeof args.cursor !== 'string' || args.cursor.length > 16_384) throw new Error('Invalid file cursor')
        request.cursor = args.cursor
      }
      if (args.limit !== undefined) {
        if (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 100)
          throw new Error('Invalid file limit')
        request.limit = args.limit
      } else request.limit = 100
    }
    const response = await dailyUseCommand(context.endpoint, { ...request, op } as DailyUseRequest<FileOp>)
    assertReviewContext(context, workspaceId)
    if (JSON.stringify(response).length > 1_000_000) throw new Error('File result exceeds the display limit')
    const expectedType = op.replace('.', '_')
    if (response.type !== expectedType) throw new Error('Invalid file response')
    return response
  })
}
