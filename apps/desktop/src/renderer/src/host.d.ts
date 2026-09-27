import type { ClientState, FeedFrame } from '@ade/client'
import type { TerminalBridge } from '@ade/terminal'
import type { BrowserBridge } from './browser'
import type { Frame, PendingSend, ProfileState, RestoreBindings, RestoreKind } from './types'

declare global {
  interface Window {
    adeHost: {
      getAppVersion(): Promise<string>
      getClientState(): Promise<ClientState>
      onClientState(listener: (state: ClientState) => void): () => void
      onFeedFrame(listener: (frame: FeedFrame) => void): () => void
      getProfileState(): Promise<ProfileState>
      listProfiles(): Promise<ProfileState>
      createProfile(name: string): Promise<ProfileState>
      selectProfile(id: string): Promise<ProfileState>
      adoptBrowserSession(profileId: string): Promise<ProfileState>
      captureBrowserProfile(profileId: string, destination: string): Promise<Record<string, unknown>>
      restoreBrowserProfile(bundle: string, profileId: string): Promise<Record<string, unknown>>
      exportSendJournalProfile(profileId: string, destination: string): Promise<Record<string, unknown>>
      importSendJournalProfile(bundle: string, sourceProfileId: string, targetProfileId: string): Promise<Record<string, unknown>>
      onProfileState(listener: (state: ProfileState) => void): () => void
      openWorkspace(folder: string): Promise<Frame>
      chooseWorkspace(): Promise<Frame | null>
      listRestoreBindings(): Promise<RestoreBindings>
      rebindRestored(profileId: string, kind: RestoreKind, id: string, folder: string): Promise<Frame>
      chooseRestoreFolder(): Promise<string | null>
      selectWorkspace(id: string, conversationId: string | null): Promise<boolean>
      requestConversation(op: string, fields: Record<string, unknown>): Promise<Frame>
      listPendingSends(): Promise<PendingSend[]>
      requestService(op: string, fields: Record<string, unknown>): Promise<Frame>
      requestScript(op: string, fields: Record<string, unknown>): Promise<Frame>
      requestReview(op: string, fields: Record<string, unknown>): Promise<Frame>
      readGitJournal(workspaceId: string): Promise<Frame>
      acknowledgeGitJournal(workspaceId: string, requestId: string, kind: 'settle' | 'interrupted'): Promise<Frame>
      requestFile(op: 'file.list' | 'file.search' | 'file.preview', fields: Record<string, unknown>): Promise<Frame>
      onDraftError(listener: (value: { conversationId: string; message: string }) => void): () => void
      terminal: TerminalBridge
      browser: BrowserBridge
    }
  }
}
