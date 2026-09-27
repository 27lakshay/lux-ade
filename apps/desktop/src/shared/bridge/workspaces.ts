import type { DailyUseResponse } from '@ade/client'
import type { RestoreBindings, RestoreKind } from './types'

/** `window.adeHost.workspaces`: the main-process `workspaces` module, including restored-binding repair. */
export interface WorkspacesBridge {
  open(folder: string): Promise<DailyUseResponse<'workspace.open'>>
  /** Null when the user cancels the folder dialog. */
  choose(): Promise<DailyUseResponse<'workspace.open'> | null>
  select(id: string, conversationId: string | null): Promise<boolean>
  listRestoreBindings(): Promise<RestoreBindings>
  rebindRestored(
    profileId: string,
    kind: RestoreKind,
    id: string,
    folder: string,
  ): Promise<DailyUseResponse<'worktree.rebind' | 'repository.rebind' | 'workspace.rebind'>>
  chooseRestoreFolder(): Promise<string | null>
}
