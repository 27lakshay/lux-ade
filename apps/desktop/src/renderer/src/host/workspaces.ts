import type { Frame, RestoreBindings, RestoreKind } from '../types'

/** `window.adeHost.workspaces`: the main-process `workspaces` module, including restored-binding repair. */
export interface WorkspacesBridge {
  open(folder: string): Promise<Frame>
  choose(): Promise<Frame | null>
  select(id: string, conversationId: string | null): Promise<boolean>
  listRestoreBindings(): Promise<RestoreBindings>
  rebindRestored(profileId: string, kind: RestoreKind, id: string, folder: string): Promise<Frame>
  chooseRestoreFolder(): Promise<string | null>
}
