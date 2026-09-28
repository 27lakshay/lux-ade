import { useNavigate } from '@tanstack/react-router'
import { Folders, Inbox, PanelsTopLeft, Search, Settings, type LucideIcon } from 'lucide-react'
import { RAIL_W, STRIP_H } from '../layout'

// The icon-only rail at the window's left edge: app-level places, before the sessions sidebar.
// Its top row is the title-bar row, where the native traffic lights sit centred.

function RailButton(props: { icon: LucideIcon; label: string; active?: boolean; dot?: boolean; onClick?: () => void }) {
  const Icon = props.icon
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-current={props.active ? 'page' : undefined}
      title={props.label}
      onClick={props.onClick}
      className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors duration-100 ${
        props.active ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-panel hover:text-fg'
      }`}
    >
      <Icon size={18} />
      {props.dot ? (
        <span className="absolute right-2 top-2 h-[7px] w-[7px] rounded-full bg-attention" aria-label="Needs you" />
      ) : null}
    </button>
  )
}

export function Rail() {
  const navigate = useNavigate()
  return (
    <nav aria-label="App" className="card flex h-full shrink-0 flex-col items-center pb-3" style={{ width: RAIL_W }}>
      <div className="drag w-full shrink-0" style={{ height: STRIP_H }} />
      <div className="mt-1 flex flex-col items-center gap-1.5">
        <RailButton icon={PanelsTopLeft} label="Workspace" active />
        <RailButton icon={Folders} label="Projects" />
        <RailButton icon={Search} label="Search" />
        <RailButton icon={Inbox} label="Activity" dot />
      </div>
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-2">
        <RailButton icon={Settings} label="Settings (⌘,)" onClick={() => void navigate({ to: '/settings' })} />
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[13px] font-semibold text-fg"
          title="Personal profile"
        >
          P
        </span>
      </div>
    </nav>
  )
}
