import { MessageSquarePlus, SquareTerminal } from 'lucide-react'

// A new tab starts empty, because it can become anything: the user picks what it is.
export function EmptyView({ onPick }: { onPick: (kind: 'chat' | 'terminal') => void }) {
  const option = 'flex w-44 items-center gap-2.5 rounded-lg bg-panel px-3 py-2.5 text-left hover:bg-muted'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <p className="m-0 text-fg-muted">Open in this tab</p>
      <button type="button" className={option} onClick={() => onPick('chat')}>
        <MessageSquarePlus size={16} className="text-fg-muted" /> New chat
      </button>
      <button type="button" className={option} onClick={() => onPick('terminal')}>
        <SquareTerminal size={16} className="text-fg-muted" /> Terminal
      </button>
    </div>
  )
}
