import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { useEffect, useRef } from 'react'
import { IconButton } from '@/components/IconButton'
import type { PaneNode } from '../model/layout'
import { dispatch, useLayout } from '../model/layout-store'
import { isDragData, type TargetData } from './drag'
import { TAB_ICON } from './Tab'

// A pane collapsed in a row: a narrow strip of its tabs' icons. Clicking one opens the pane on that
// tab; a tab dropped on the strip joins the pane.
export function CollapsedPane({ pane, expand }: { pane: PaneNode; expand: () => void }) {
  const tabs = useLayout((layout) => layout.tabs)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    return dropTargetForElements({
      element: ref.current,
      canDrop: ({ source }) => isDragData(source.data) && source.data.kind === 'tab',
      getData: (): TargetData => ({ kind: 'strip-target', paneId: pane.id, index: Number.MAX_SAFE_INTEGER }),
    })
  }, [pane.id])
  return (
    <div ref={ref} data-collapsed-pane={pane.id} className="flex min-h-0 flex-1 flex-col items-center gap-0.5 py-1.5">
      {pane.tabs.map((id) =>
        tabs[id] ? (
          <IconButton
            key={id}
            icon={TAB_ICON[tabs[id].kind]}
            label={tabs[id].title}
            side="right"
            selected={pane.active === id}
            onClick={() => {
              dispatch({ type: 'activateTab', tabId: id })
              expand()
            }}
          />
        ) : null,
      )}
      <IconButton icon="expand" label="Expand pane" side="right" onClick={expand} />
    </div>
  )
}
