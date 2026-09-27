import type { Frame } from '../types'

/** `window.adeHost.review`: the main-process `review` module and its git intent journal. */
export interface ReviewBridge {
  request(op: string, fields: Record<string, unknown>): Promise<Frame>
  readGitJournal(workspaceId: string): Promise<Frame>
  acknowledgeGitJournal(workspaceId: string, requestId: string, kind: 'settle' | 'interrupted'): Promise<Frame>
}
