import type { ResolvedTerminalAppearance, ThemeBinding } from '@ade/contracts'

/** `window.adeHost.terminals`: the workspace terminals' lifecycle. Their output streams through `terminal`. */
export interface TerminalsBridge {
  appearance(workspaceId: string, terminalId: string): Promise<ResolvedTerminalAppearance>
  setAppearance(
    workspaceId: string,
    terminalId: string,
    binding: ThemeBinding | null,
    expectedRevision: number,
  ): Promise<ResolvedTerminalAppearance>

  /**
   * Starts a shell in the workspace and opens its tab in this window, in `paneId` or the focused
   * pane, in one daemon command. Returns the terminal's ID. A shell closes with its last tab
   * (`layouts.closeTab`).
   */
  create(workspaceId: string, paneId?: string): Promise<string>
  /** Starts the terminal's shell again, as a fresh process. */
  restart(workspaceId: string, terminalId: string): Promise<void>
}
