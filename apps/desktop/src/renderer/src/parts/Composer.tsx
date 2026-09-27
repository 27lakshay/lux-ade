import { useState } from 'react'
import { ArrowUp, ChevronDown, Plus, Shield } from 'lucide-react'
import { IconButton } from './IconButton'

// Share of the model's context window in use, shown as a ring beside the send button.
function ContextRing({ used }: { used: number }) {
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <span className="flex h-7 w-7 items-center justify-center" title={`${Math.round(used * 100)}% of context used`}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border)" strokeWidth="2" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="var(--fg-muted)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${c * used} ${c}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
    </span>
  )
}

function Chip({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <button type="button" aria-label={label} className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-fg-muted hover:bg-panel hover:text-fg">
      {children}
      <ChevronDown size={12} className="opacity-60" />
    </button>
  )
}

// Prompt composer: a growing text field over a footer of session controls. Enter sends,
// Shift+Enter adds a line. In the prototype, sending just clears the field.
export function Composer() {
  const [text, setText] = useState('')
  const canSend = text.trim().length > 0
  const send = () => {
    if (canSend) setText('')
  }

  return (
    <section className="rounded-2xl bg-raised shadow-[0_8px_24px_#00000059]">
      <textarea
        aria-label="Message Claude Code"
        placeholder="Ask for follow-up changes, @ to mention a file"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        className="block max-h-[40vh] min-h-[calc(2lh+1.125rem)] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-[1.55] text-fg outline-none [field-sizing:content] placeholder:text-fg-muted"
      />
      <div className="flex items-center gap-1 overflow-hidden px-2 pb-2 text-[12px]">
        <IconButton label="Attach files or context">
          <Plus size={16} />
        </IconButton>
        <Chip label="Permission mode">
          <Shield size={13} /> Ask before commands
        </Chip>
        <span className="flex-1" />
        <Chip label="Model">
          <span className="text-fg">Opus 5.5</span>
        </Chip>
        <Chip label="Reasoning effort">High</Chip>
        <ContextRing used={0.58} />
        <button
          type="button"
          aria-label="Send (Enter)"
          disabled={!canSend}
          onClick={send}
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-full bg-fg text-inverse transition-opacity duration-150 disabled:opacity-30"
        >
          <ArrowUp size={15} strokeWidth={2.25} />
        </button>
      </div>
    </section>
  )
}
