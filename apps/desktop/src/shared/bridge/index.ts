import type { TerminalBridge } from '@ade/terminal'
import type { AppCommand } from '../app-commands'
import type { BrowserBridge } from './browser'
import type { ConversationsBridge } from './conversations'
import type { FilesBridge } from './files'
import type { ProfilesBridge } from './profiles'
import type { ReviewBridge } from './review'
import type { ServicesBridge } from './services'
import type { WorkspacesBridge } from './workspaces'

/**
 * `window.adeHost`: the only way the renderer reaches the rest of the app. The preload implements it
 * (src/preload/index.ts); each domain owns its interface in this folder. The IPC channels behind
 * it are typed from these interfaces in ../ipc.ts.
 */
export interface AdeHost {
  getAppVersion(): Promise<string>
  setTheme(theme: 'dark' | 'light'): void
  /** Commands from the native menu; returns the unsubscribe function. */
  onCommand(listener: (command: AppCommand) => void): () => void
  profiles: ProfilesBridge
  conversations: ConversationsBridge
  workspaces: WorkspacesBridge
  services: ServicesBridge
  review: ReviewBridge
  files: FilesBridge
  browser: BrowserBridge
  terminal: TerminalBridge
}
