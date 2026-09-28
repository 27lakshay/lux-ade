import type { TerminalBridge } from '@ade/terminal'
import type { AppCommand } from '../app-commands'
import type { ThemePreference } from '../window-chrome'
import type { BrowserBridge } from './browser'
import type { ConversationsBridge } from './conversations'
import type { FilesBridge } from './files'
import type { ProfilesBridge } from './profiles'
import type { ReviewBridge } from './review'
import type { ServicesBridge } from './services'
import type { TerminalsBridge } from './terminals'
import type { WorkspacesBridge } from './workspaces'

/**
 * `window.adeHost`: the only way the renderer reaches the rest of the app. The preload implements it
 * (src/preload/index.ts); each domain owns its interface in this folder. The IPC channels behind
 * it are typed from these interfaces in ../ipc.ts.
 */
export interface AdeHost {
  getAppVersion(): Promise<string>
  /** Mirrors the appearance preference to the native window, which remembers it for next launch. */
  setTheme(theme: ThemePreference): void
  /**
   * The smallest the window may be, in pixels: what its pane layout needs with both sidebars
   * closed. Main never goes below its own minimum (720 × 480).
   */
  setWindowMinimumSize(width: number, height: number): void
  /** Commands from the native menu; returns the unsubscribe function. */
  onCommand(listener: (command: AppCommand) => void): () => void
  profiles: ProfilesBridge
  conversations: ConversationsBridge
  workspaces: WorkspacesBridge
  services: ServicesBridge
  review: ReviewBridge
  files: FilesBridge
  browser: BrowserBridge
  /** A terminal's output and input, over the stream bridge. */
  terminal: TerminalBridge
  terminals: TerminalsBridge
}
