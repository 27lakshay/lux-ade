import type { DaemonState } from '../../../state/daemon-store'
import type { Layout, TabTarget } from './layout'

// A tab's title comes from what it shows: a conversation's or terminal's own title from the
// daemon's catalog, a file's name. Renaming the record renames its tabs everywhere.

const baseName = (path: string): string => path.split('/').at(-1) || path

/** The title a target has without looking anything up. */
export function targetLabel(target: TabTarget | undefined): string {
  switch (target?.kind) {
    case 'terminal':
      return 'Terminal'
    case 'conversation':
      return 'Conversation'
    case 'browser':
      return 'Browser'
    case 'file':
      return baseName(target.path)
    case 'diff':
      return `${baseName(target.path)} (${target.staged ? 'staged' : 'changes'})`
    default:
      return 'New conversation'
  }
}

/** The title a target shows, from the catalog when it names a record there. */
export function targetTitle(state: DaemonState, target: TabTarget | undefined): string {
  if (target?.kind === 'terminal') return state.terminals[target.id]?.title || targetLabel(target)
  if (target?.kind === 'conversation') return state.conversations[target.id]?.title || targetLabel(target)
  return targetLabel(target)
}

/** A tab's title where no catalog is at hand (announcements): as its tab shows it, else its kind. */
export const tabTitle = (layout: Layout, tabId: string): string =>
  document.getElementById(tabId)?.textContent?.trim() || targetLabel(layout.tabs[tabId]?.target)
