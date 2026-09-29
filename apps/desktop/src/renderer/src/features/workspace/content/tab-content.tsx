import type { RenderContent } from './ContentHosts'
import { TerminalContent } from '../terminals/TerminalContent'

// What each tab shows in the app. Terminals are real; conversations, browsers, files and diffs are
// empty until their surfaces are built.
export const tabContent: RenderContent = (tab, workspaceId) =>
  tab.target.kind === 'terminal' ? (
    <TerminalContent tabId={tab.id} workspaceId={workspaceId} terminalId={tab.target.id} />
  ) : null
