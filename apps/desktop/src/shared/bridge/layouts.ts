import type { LayoutAction, LayoutRecord, Window } from '@ade/contracts'

/**
 * `window.adeHost.layouts`: this window's record and its layouts, in the daemon (`window.*`,
 * `layout.*`, `tab.close`, `pane.close`). Main fills in the window's record ID; the renderer never
 * names another window.
 */
export interface LayoutsBridge {
  /** This window's record ID, or null while main has none for it (no daemon yet). */
  windowId(): Promise<string | null>
  /** Main gave this window another record (a profile switch); returns the unsubscribe function. */
  onWindowId(listener: (windowId: string | null) => void): () => void
  get(workspaceId: string): Promise<LayoutRecord>
  /** `expectedRevision` is required for `move_pane`, `swap_panes` and `dock_pane`. */
  apply(workspaceId: string, action: LayoutAction, expectedRevision?: number): Promise<LayoutOutcome>
  /** Closes a tab, and the shell whose last tab it is; a busy shell refuses unless `force`. */
  closeTab(workspaceId: string, tabId: string, force: boolean): Promise<LayoutOutcome>
  /** Closes a pane and its tabs, and each shell whose last tab it holds, as `closeTab` does. */
  closePane(workspaceId: string, paneId: string, force: boolean): Promise<LayoutOutcome>
  /** Shows another workspace in this window. */
  showWorkspace(workspaceId: string): Promise<Window>
  /** The project rows the navigator shows collapsed in this window. */
  setCollapsedProjects(projectIds: string[]): Promise<Window>
}

/** A shell `closeTab` or `closePane` would stop while a command runs in it. */
export interface BusyTerminal {
  terminal_id: string
  /** The command in the foreground, when the daemon could name it. */
  foreground: string | null
}

/**
 * The outcome of a layout command. The daemon's expected refusals come back as values, since an
 * error thrown across IPC keeps only its message: `layout_conflict` (the layout moved on; read it
 * again), `terminal_busy` (confirm, then close with `force`), and the others by their code.
 */
export type LayoutOutcome =
  | { ok: true; layout: LayoutRecord; changed: boolean }
  | { ok: false; code: string; message: string; terminals: BusyTerminal[] }
