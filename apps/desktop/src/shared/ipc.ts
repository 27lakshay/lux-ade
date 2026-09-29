import type { AppCommand } from './app-commands'
import type { AdeHost } from './bridge'
import type { BrowserBridge, BrowserState } from './bridge/browser'
import type { ConversationsBridge } from './bridge/conversations'
import type { FilesBridge } from './bridge/files'
import type { LayoutsBridge } from './bridge/layouts'
import type { ProfilesBridge } from './bridge/profiles'
import type { ReviewBridge } from './bridge/review'
import type { ServicesBridge } from './bridge/services'
import type { ProfileState } from './bridge/types'
import type { SettingsBridge } from './bridge/settings'
import type { TerminalsBridge } from './bridge/terminals'
import type { WorkspacesBridge } from './bridge/workspaces'

// The IPC contract between main and preload. Each request channel is typed as the bridge method
// (./bridge) it serves, so the preload can only call it with that method's arguments and main must
// return that method's result. Main still receives arguments as `unknown` and validates them: the
// renderer is not trusted. Use the helpers in src/main/ipc.ts and src/preload/ipc.ts, never
// ipcMain or ipcRenderer directly.

/** Renderer → main requests (`invoke` / `handle`). */
export interface InvokeChannels {
  'ade:app-version': AdeHost['getAppVersion']

  'ade:profile-state': ProfilesBridge['getState']
  'ade:profile-list': ProfilesBridge['list']
  'ade:profile-create': ProfilesBridge['create']
  'ade:profile-select': ProfilesBridge['select']
  'ade:client-state': ProfilesBridge['getClientState']

  'ade:conversation-request': ConversationsBridge['request']
  'ade:pending-sends': ConversationsBridge['listPendingSends']
  'ade:send-journal-export': ConversationsBridge['exportSendJournal']
  'ade:send-journal-import': ConversationsBridge['importSendJournal']

  'ade:workspace-open': WorkspacesBridge['open']
  'ade:workspace-choose': WorkspacesBridge['choose']
  'ade:workspace-rename': WorkspacesBridge['rename']
  'ade:workspace-remove': WorkspacesBridge['remove']
  'ade:worktree-create': WorkspacesBridge['createWorktree']
  'ade:worktree-delete': WorkspacesBridge['deleteWorktree']
  'ade:terminal-create': TerminalsBridge['create']
  'ade:settings-get': SettingsBridge['get']
  'ade:settings-set': SettingsBridge['set']
  'ade:terminal-restart': TerminalsBridge['restart']
  'ade:window-id': LayoutsBridge['windowId']
  'ade:layout-get': LayoutsBridge['get']
  'ade:layout-apply': LayoutsBridge['apply']
  'ade:layout-replace': LayoutsBridge['replace']
  'ade:tab-close': LayoutsBridge['closeTab']
  'ade:pane-close': LayoutsBridge['closePane']
  'ade:window-show-workspace': LayoutsBridge['showWorkspace']
  'ade:window-collapse': LayoutsBridge['setCollapsedProjects']
  'ade:restore-bindings': WorkspacesBridge['listRestoreBindings']
  'ade:restore-binding': WorkspacesBridge['rebindRestored']
  'ade:restore-choose-folder': WorkspacesBridge['chooseRestoreFolder']

  'ade:service-request': ServicesBridge['request']
  'ade:script-request': ServicesBridge['requestScript']
  'ade:review-request': ReviewBridge['request']
  'ade:git-journal-read': ReviewBridge['readGitJournal']
  'ade:git-journal-ack': ReviewBridge['acknowledgeGitJournal']
  'ade:file-request': FilesBridge['request']

  'ade:browser-list': BrowserBridge['list']
  'ade:browser-open': BrowserBridge['open']
  'ade:browser-select': BrowserBridge['select']
  'ade:browser-new': BrowserBridge['newTab']
  'ade:browser-navigate': BrowserBridge['navigate']
  'ade:browser-history': BrowserBridge['history']
  'ade:browser-close': BrowserBridge['close']
  'ade:browser-bounds': BrowserBridge['bounds']
  'ade:browser-hide': BrowserBridge['hide']
  'ade:browser-adopt': BrowserBridge['adoptSession']
  'ade:browser-backup-capture': BrowserBridge['captureProfile']
  'ade:browser-backup-restore': BrowserBridge['restoreProfile']

  /** Asks main for a fresh MessagePort to the stream bridge; it arrives as `ade:stream-port`. */
  'ade:stream-connect': () => Promise<boolean>
}

/** Renderer → main messages with no reply (`send` / `listen`). */
export interface SendChannels {
  'ade:theme': AdeHost['setTheme']
  'ade:window-minimum-size': AdeHost['setWindowMinimumSize']
}

/** Main → renderer events (`emit` / `broadcast` / `subscribe`), as the arguments they carry. */
export interface EventChannels {
  'ade:command': [command: AppCommand]
  'ade:client-state-changed': [state: Awaited<ReturnType<ProfilesBridge['getClientState']>>]
  'ade:profile-state-changed': [state: ProfileState]
  'ade:draft-error': [error: { conversationId: string; message: string }]
  /** Main gave the window another daemon record (a profile switch, or the daemon came up late). */
  'ade:window-id-changed': [windowId: string | null]
  'ade:browser-state': [state: BrowserState]
  'ade:browser-lease-lost': [profileId: string]
  /** The stream bridge restarted; its ports are closed. Reconnect with `ade:stream-connect`. */
  'ade:stream-lost': []
}

/**
 * Main → renderer MessagePort deliveries (webContents.postMessage with a transfer list). The
 * conversation feed and terminal streams run over this port, not over IPC (src/shared/stream-bridge.ts).
 */
export type PortChannel = 'ade:stream-port'

export type InvokeChannel = keyof InvokeChannels
export type SendChannel = keyof SendChannels
export type EventChannel = keyof EventChannels
