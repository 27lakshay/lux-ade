import type { Frame } from './types'

/** `window.adeHost.files`: the main-process `files` module. */
export interface FilesBridge {
  request(op: 'file.list' | 'file.search' | 'file.preview', fields: Record<string, unknown>): Promise<Frame>
}
