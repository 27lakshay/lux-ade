/** `window.adeHost.terminals`: the workspace terminals' lifecycle. Their output streams through `terminal`. */
export interface TerminalsBridge {
  /**
   * Starts a shell in the workspace and opens its tab in this window, in `paneId` or the focused
   * pane, in one daemon command. Returns the terminal's ID. A shell closes with its last tab
   * (`layouts.closeTab`).
   */
  create(workspaceId: string, paneId?: string): Promise<string>
  /** Starts the terminal's shell again, as a fresh process. */
  restart(workspaceId: string, terminalId: string): Promise<void>
}
