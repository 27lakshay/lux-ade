/** `window.adeHost.terminals`: the workspace terminals' lifecycle. Their output streams through `terminal`. */
export interface TerminalsBridge {
  /** Starts a shell in the workspace and returns its terminal ID. */
  create(workspaceId: string): Promise<string>
  /**
   * Stops a shell and removes it from its workspace. A busy shell is not closed unless `force`;
   * the outcome names what is running. Other terminals (a service's, a script's) are left running.
   */
  close(terminalId: string, force?: boolean): Promise<TerminalCloseOutcome>
  /** Starts the terminal's shell again, as a fresh process. */
  restart(workspaceId: string, terminalId: string): Promise<void>
}

/** `running` is the command in the foreground, when the daemon could name it. */
export type TerminalCloseOutcome = { closed: true } | { closed: false; running: string | null }
