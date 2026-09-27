import type { TerminalBridge } from '@ade/terminal'
import type { AppCommand } from '../../shared/app-commands'
import type { BrowserBridge } from './host/browser'
import type { ConversationsBridge } from './host/conversations'
import type { FilesBridge } from './host/files'
import type { ProfilesBridge } from './host/profiles'
import type { ReviewBridge } from './host/review'
import type { ServicesBridge } from './host/services'
import type { WorkspacesBridge } from './host/workspaces'

/** The preload bridge. Each domain owns its interface under `./host`; this type only composes them. */
interface AdeHost {
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

declare global {
  interface Window {
    adeHost: AdeHost
  }
}
