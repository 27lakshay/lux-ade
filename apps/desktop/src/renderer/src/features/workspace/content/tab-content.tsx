import type { RenderContent } from './ContentHosts'
import { ConversationContent } from '../conversation/ConversationContent'
import { TerminalContent } from '../terminals/TerminalContent'

// What each tab shows in the app.
export const tabContent: RenderContent = (tab, workspaceId) =>
  tab.target.kind === 'terminal' ? (
    <TerminalContent tabId={tab.id} workspaceId={workspaceId} terminalId={tab.target.id} />
  ) : tab.target.kind === 'conversation' ? (
    <ConversationContent conversationId={tab.target.id} tabId={tab.id} />
  ) : null
