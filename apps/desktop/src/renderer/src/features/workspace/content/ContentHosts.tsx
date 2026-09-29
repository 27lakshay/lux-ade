import { memo, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ErrorBoundary } from 'react-error-boundary'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { ErrorReport } from '../../../provisional/ErrorReport'
import { tabKind, type Tab } from '../model/layout'
import { activeWorkspace, keptWorkspaces, layoutStore, type LayoutState } from '../model/layout-store'
import { hostFor, releaseHost } from './hosts'
import { tabContent } from './tab-content'

// Renders the content of every tab in the recently used workspaces, once, each into its own host
// element (hosts.ts). Mounted once for the window: panes only attach and detach the elements.
// A tab's content unmounts when its workspace leaves the recent list (and mounts again, fresh,
// when it returns); its element is released only when the tab itself closes. Terminals are kept
// for fewer workspaces (keepTerminals, 1 by default): they cost the most memory, and a terminal
// attaches again from the daemon.

/** What a tab shows, given the workspace whose layout holds it (tab-content.tsx in the app). */
export type RenderContent = (tab: Tab, workspaceId: string) => ReactNode

const tabExists = (tabId: string): boolean =>
  Object.values(layoutStore.getState().records).some((record) => tabId in record.layout.tabs)

const workspaceOf = (state: LayoutState, tabId: string): string =>
  Object.values(state.records).find((record) => tabId in record.layout.tabs)?.workspace_id ??
  activeWorkspace(state) ??
  ''

// Memoised: the list of kept tabs changes whenever a tab opens or closes, and each host whose tab
// did not change then skips rendering.
const TabHost = memo(function TabHost({ tab, render }: { tab: Tab; render: RenderContent }) {
  const workspaceId = useStore(layoutStore, (state) => workspaceOf(state, tab.id))
  useEffect(
    () => () => {
      if (!tabExists(tab.id)) releaseHost(tab.id)
    },
    [tab.id],
  )
  return createPortal(
    <ErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) => <ErrorReport error={error} onRetry={resetErrorBoundary} />}
    >
      {render(tab, workspaceId)}
    </ErrorBoundary>,
    hostFor(tab.id),
    tab.id,
  )
})

/** Terminals only for the most recent `keepTerminals` workspaces; other content for all kept ones. */
const keptTabs = (state: LayoutState): Tab[] =>
  keptWorkspaces(state).flatMap((workspace, index) =>
    Object.values(state.records[workspace]?.layout.tabs ?? {}).filter(
      (tab) => tabKind(tab.target) !== 'terminal' || index < Math.min(state.keepTerminals, state.keepMounted),
    ),
  )

export function ContentHosts({ render = tabContent }: { render?: RenderContent }) {
  // Compared item by item: an unrelated layout change keeps the same tabs and renders nothing.
  const tabs = useStore(layoutStore, useShallow(keptTabs))
  return tabs.map((tab) => <TabHost key={tab.id} tab={tab} render={render} />)
}
