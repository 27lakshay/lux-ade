import { IconButton } from '@/components/IconButton'
import { Card } from '../cards/Card'
import { Grip } from '../cards/Grip'
import type { PaneNode } from '../model/layout'
import { dispatch, openTab, splitPane, useLayout } from '../model/layout-store'
import { PaneEmptyState } from './PaneEmptyState'
import { Tab } from './Tab'

// A pane: its tab strip (tabs, new tab, split and menu), its body, and the grip that moves it.
// Content stays empty for now; the content hosts attach it into the body (data-pane-body).
export function Pane({ pane }: { pane: PaneNode }) {
  const focused = useLayout((layout) => layout.focusedPane === pane.id)
  const tabs = useLayout((layout) => layout.tabs)
  return (
    <Card surface="pane" label="Pane" grip={<Grip label="Move pane" />}>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onPointerDownCapture={() => !focused && dispatch({ type: 'focusPane', paneId: pane.id })}
      >
        <div className="flex h-10 shrink-0 items-center gap-0.5 px-1.5">
          <div role="tablist" aria-label="Tabs" className="flex min-w-0 items-center gap-0.5">
            {pane.tabs.map(
              (id) => tabs[id] && <Tab key={id} tab={tabs[id]} active={pane.active === id} focused={focused} />,
            )}
          </div>
          <IconButton
            icon="new"
            label="New tab"
            shortcut={{ appCommand: 'new-tab' }}
            onClick={() => openTab({ kind: 'conversation', title: 'New conversation' }, pane.id)}
          />
          <div className="flex-1" />
          <IconButton
            icon="splitRight"
            label="Split right"
            shortcut={{ appCommand: 'split-right' }}
            onClick={() => splitPane(pane.id, 'row')}
          />
          <IconButton icon="splitDown" label="Split down" onClick={() => splitPane(pane.id, 'column')} />
          <IconButton
            icon="close"
            label="Close pane"
            onClick={() => dispatch({ type: 'closePane', paneId: pane.id })}
          />
        </div>
        {pane.tabs.length === 0 ? (
          <PaneEmptyState paneId={pane.id} />
        ) : (
          <div data-pane-body={pane.id} className="min-h-0 flex-1" />
        )}
      </div>
    </Card>
  )
}
