import { invoke } from './ipc'
import type { FilesBridge } from '../shared/bridge/files'

export const files: FilesBridge = {
  request: (op, fields) => invoke('ade:file-request', op, fields),
}
