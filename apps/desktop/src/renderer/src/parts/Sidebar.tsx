import { Bot, ChevronsUpDown, CircleCheck, FolderPlus, Search, Settings, SquarePen } from 'lucide-react'
import { STRIP_H } from '../layout'
import { IconButton } from './IconButton'

type Kind = 'attention' | 'running' | 'review' | 'idle'

const GROUPS: { label: string; items: { kind: Kind; title: string; activity: string; where: string; time: string; selected?: boolean }[] }[] = [
  { label: 'Needs you', items: [{ kind: 'attention', title: 'Design review pass', activity: 'Wants to run pnpm test:e2e', where: 'lux-ade · main', time: '2m', selected: true }] },
  { label: 'Working', items: [{ kind: 'running', title: 'Packaging E2E', activity: 'Running electron-builder', where: 'lux-ade · main', time: '38s' }] },
  { label: 'Ready to review', items: [{ kind: 'review', title: 'Service ports', activity: 'Finished · 3 files changed', where: 'lux-ade · feat/services', time: '6m' }] },
  { label: 'Idle', items: [{ kind: 'idle', title: 'Notes cleanup', activity: 'Waiting for your next message', where: 'notes', time: '1h' }] },
]

function StatusMark({ kind }: { kind: Kind }) {
  if (kind === 'attention')
    return (
      <span className="relative mt-[3px] block h-3 w-3 shrink-0 rounded-full bg-attention-muted" aria-label="Needs you">
        <span className="absolute inset-[2.5px] rounded-full bg-attention" />
      </span>
    )
  if (kind === 'running')
    return (
      <span
        className="mt-[3px] block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--border)] border-t-running [animation-duration:1.1s]"
        aria-label="Running"
      />
    )
  if (kind === 'review') return <CircleCheck size={14} className="mt-[2px] shrink-0 text-success" aria-label="Ready to review" />
  return <span className="mt-[4px] block h-[7px] w-[7px] shrink-0 rounded-full border border-fg-muted" aria-label="Idle" />
}

export function Sidebar() {
  return (
    <div className="flex h-full flex-col px-1.5 pb-1.5">
      {/* Top row is the title-bar row: the traffic lights and the window-level sidebar toggle sit
          over it. It holds nothing itself, so all of it drags the window. */}
      <div className="drag shrink-0" style={{ height: STRIP_H }} />
      <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel">
        <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-muted text-[11px] font-semibold">P</span>
        <span className="flex-1 font-semibold">Personal</span>
        <ChevronsUpDown size={14} className="text-fg-muted" />
      </button>
      <div className="mt-1 flex flex-col">
        {[
          [SquarePen, 'New conversation', '⌘N'],
          [Search, 'Search', '⌘K'],
        ].map(([Icon, label, kbd]) => (
          <button key={label as string} type="button" className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-panel">
            <Icon size={16} className="text-fg-muted" />
            <span className="flex-1">{label as string}</span>
            <span className="font-mono text-[11px] text-fg-muted">{kbd as string}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
        {GROUPS.map((g) => (
          <div key={g.label} className="flex flex-col">
            <div className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-[11px] font-medium text-fg-muted">
              {g.label} <span>{g.items.length}</span>
            </div>
            {g.items.map((it) => (
              <button
                key={it.title}
                type="button"
                className={`flex gap-2.5 rounded-md px-2 py-2 text-left ${it.selected ? 'bg-selected' : 'hover:bg-panel'}`}
              >
                <StatusMark kind={it.kind} />
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="flex items-center gap-1.5">
                    <span className="flex-1 truncate font-medium">{it.title}</span>
                    <span className={`text-[11px] ${it.kind === 'attention' ? 'text-attention' : 'text-fg-muted'}`}>{it.time}</span>
                  </span>
                  <span className={`truncate text-[12px] ${it.kind === 'attention' ? 'text-attention' : 'text-fg-muted'}`}>{it.activity}</span>
                  <span className="truncate font-mono text-[11px] text-fg-muted">{it.where}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 px-1 py-1.5">
        <IconButton label="Open folder">
          <FolderPlus size={16} />
        </IconButton>
        <IconButton label="Agents & accounts">
          <Bot size={16} />
        </IconButton>
        <IconButton label="Settings (⌘,)">
          <Settings size={16} />
        </IconButton>
      </div>
    </div>
  )
}
