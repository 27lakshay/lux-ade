import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { motion, type Transition } from 'motion/react'
import { Columns2, Ellipsis, Plus, SquareTerminal, X } from 'lucide-react'
import { IconButton } from '../parts/IconButton'
import { Grip } from '../parts/Grip'
import { ChatView } from '../parts/Chat'
import { TerminalView } from '../parts/TerminalView'
import { EmptyView } from '../parts/EmptyView'
import { STRIP_H } from '../layout'
import type { Layout, Pane as PaneModel, Tab } from './model'

// Panes and tabs glide to their new places when the layout changes: after a drop, and live while
// a reorder is in progress.
export const LAYOUT_SPRING: Transition = { type: 'spring', stiffness: 520, damping: 44 }

function TabMark({ tab }: { tab: Tab }) {
  if (tab.kind === 'terminal') return <SquareTerminal size={13} className="text-fg-muted" />
  if (tab.status === 'attention') return <span className="h-2 w-2 rounded-full bg-attention" />
  if (tab.status === 'running') return <span className="h-2 w-2 rounded-full bg-running" />
  return null
}

interface Props {
  pane: PaneModel
  layout: Layout
  // This pane's share of its split (flex-grow).
  grow: number
  // True while a divider is being dragged: layout changes then apply at once instead of gliding.
  resizing: boolean
  leading?: ReactNode
  trailing?: ReactNode
  draggedTab: string | null
  draggedPane: boolean
  paneRef: (el: HTMLElement | null) => void
  stripRef: (el: HTMLElement | null) => void
  onTabPointerDown: (e: ReactPointerEvent, tabId: string) => void
  // Any press inside the pane makes it the current pane for commands.
  onActivate: () => void
  onGripPointerDown: (e: ReactPointerEvent) => void
  onClose: (tabId: string) => void
  onAdd: () => void
  onSplit: () => void
  onPick: (tabId: string, kind: 'chat' | 'terminal') => void
}

export function Pane(p: Props) {
  const active = p.layout.tabs[p.pane.active]
  return (
    <motion.section
      ref={p.paneRef}
      onPointerDownCapture={p.onActivate}
      layout
      layoutId={p.pane.id}
      transition={{ layout: p.resizing ? { duration: 0 } : LAYOUT_SPRING }}
      className="card flex min-h-0 min-w-0 flex-col"
      style={{ ['--card-bg' as string]: 'var(--app-bg)', flex: `${p.grow} 1 0px` }}
      animate={{ opacity: p.draggedPane ? 0.4 : 1 }}
      aria-label={active?.title}
      data-pane-id={p.pane.id}
    >
      {/* Tab strip: empty space drags the window (turned off while a pane or tab is dragged). */}
      <motion.div
        ref={p.stripRef}
        layout="position"
        className="drag flex shrink-0 items-center gap-0.5 overflow-hidden px-1.5"
        style={{ height: STRIP_H }}
        role="tablist"
      >
        {p.leading}
        {p.pane.tabs.map((id) => {
          const tab = p.layout.tabs[id]
          const selected = id === p.pane.active
          return (
            <motion.div
              key={id}
              layout="position"
              layoutId={`tab-${id}`}
              transition={{ layout: LAYOUT_SPRING }}
              data-tab-id={id}
              role="tab"
              aria-selected={selected}
              tabIndex={0}
              onPointerDown={(e) => p.onTabPointerDown(e, id)}
              animate={{ opacity: p.draggedTab === id ? 0.35 : 1 }}
              className={`no-drag flex h-[30px] min-w-0 shrink items-center gap-2 rounded-md px-2.5 text-[12px] ${
                selected ? 'bg-muted font-medium text-fg' : 'text-fg-muted hover:bg-panel'
              }`}
            >
              <TabMark tab={tab} />
              <span className="truncate">{tab.title}</span>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                className="-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-panel hover:text-fg"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => p.onClose(id)}
              >
                <X size={11} />
              </button>
            </motion.div>
          )
        })}
        <IconButton label="New tab (⌘T)" onClick={p.onAdd}>
          <Plus size={14} />
        </IconButton>
        <div className="min-w-2 flex-1" />
        <IconButton label="Split right (⌘\)" onClick={p.onSplit}>
          <Columns2 size={16} />
        </IconButton>
        <IconButton label="Pane menu">
          <Ellipsis size={16} />
        </IconButton>
        {p.trailing}
      </motion.div>

      {/* The body takes `layout` too so its contents are scale-corrected while the card resizes. */}
      <motion.div layout transition={{ layout: p.resizing ? { duration: 0 } : LAYOUT_SPRING }} className="relative min-h-0 flex-1">
        {active?.kind === 'chat' ? <ChatView title={active.title} /> : null}
        {active?.kind === 'terminal' ? <TerminalView title={active.title} /> : null}
        {active?.kind === 'empty' ? <EmptyView onPick={(kind) => p.onPick(active.id, kind)} /> : null}
      </motion.div>

      {/* Grip: drag the whole pane from here. */}
      <motion.div layout="position">
        <Grip label={`Move pane: ${active?.title}`} onDragStart={p.onGripPointerDown} />
      </motion.div>
    </motion.section>
  )
}
