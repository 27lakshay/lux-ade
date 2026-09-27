import type { ContractRequest, FileOperation } from './operations'

/** `window.adeHost.files`: the main-process `files` module. */
export interface FilesBridge {
  request: ContractRequest<FileOperation>
}
