import { forward } from './ipc'
import type { FilesBridge } from '../shared/bridge/files'

export const files: FilesBridge = {
  request: forward('ade:file-request'),
}
