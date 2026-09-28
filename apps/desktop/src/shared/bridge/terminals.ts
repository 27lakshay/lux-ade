/** `window.adeHost.terminals`: the workspace terminals' lifecycle. Their output streams through `terminal`. */
export interface TerminalsBridge {
  /** Starts a shell in the workspace and returns its terminal ID. */
  create(workspaceId: string): Promise<string>
  /** Stops the terminal and removes it from its workspace. */
  close(workspaceId: string, terminalId: string): Promise<void>
  /** Starts the terminal's shell again, as a fresh process. */
  restart(workspaceId: string, terminalId: string): Promise<void>
}
