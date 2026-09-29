import type { DailyUseResponse } from '@ade/client'
import type { RestoreBindings, RestoreKind } from './types'

/** `window.adeHost.workspaces`: the main-process `workspaces` module, including restored-binding repair. */
export interface WorkspacesBridge {
  open(folder: string): Promise<DailyUseResponse<'workspace.open'>>
  /** Null when the user cancels the folder dialog. */
  choose(): Promise<DailyUseResponse<'workspace.open'> | null>
  listRestoreBindings(): Promise<RestoreBindings>
  rebindRestored(
    profileId: string,
    kind: RestoreKind,
    id: string,
    folder: string,
  ): Promise<DailyUseResponse<'worktree.rebind' | 'repository.rebind' | 'workspace.rebind'>>
  chooseRestoreFolder(): Promise<string | null>
  /** Changes the name ADE shows; the folder keeps its name. */
  rename(id: string, name: string): Promise<void>
  /** Removes the workspace from ADE and keeps its files; refused while something in it runs. */
  remove(id: string): Promise<RemoveOutcome>
  /** Creates a worktree of a repository project, opens it, and returns the new workspace's ID. */
  createWorktree(projectId: string, name: string): Promise<string>
  /** Removes the workspace from ADE, then deletes its worktree folder; refused with reasons. */
  deleteWorktree(id: string): Promise<RemoveOutcome>
}

/** A removal either happened or was refused, with each reason in words a person reads. */
export type RemoveOutcome = { removed: true } | { removed: false; reasons: string[] }
