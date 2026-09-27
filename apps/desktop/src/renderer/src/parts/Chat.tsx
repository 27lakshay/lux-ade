import { Asterisk, ChevronRight, FileDiff, SquareTerminal } from 'lucide-react'
import { Composer } from './Composer'

interface Transcript {
  meta: string
  prompt: string
  worked: string
  reply: string
  change?: { files: number; added: number; removed: number }
}

// Sample transcripts keyed by chat title; any other chat gets the first one.
const TRANSCRIPTS: Record<string, Transcript> = {
  'Design review pass': {
    meta: 'Claude Code · Opus 5.5 · Work account · lux-ade on main',
    prompt:
      "Tighten the service start flow. An assigned port shouldn't read as listening until the child actually binds. Run the E2E when you're done.",
    worked: 'Worked for 38s · read 1 file, edited 1, ran typecheck',
    reply:
      'The daemon already tracks the assigned port separately from the process, so the fix is in how we present it. I added a listening state that only appears after a bind is observed. Until then the service row says “assigned”.',
    change: { files: 1, added: 24, removed: 6 },
  },
  'Packaging E2E': {
    meta: 'Codex · GPT-5.5 · Personal · lux-ade on main',
    prompt: 'Package the desktop app with electron-builder and run the packaged smoke test.',
    worked: 'Working for 38s · ran pnpm build, running electron-builder',
    reply:
      'The renderer and main bundles built cleanly. electron-builder is signing the app now; the smoke test runs against the signed build next.',
  },
}

// One chat session's transcript and composer. Fills its pane; the pane owns the tab strip.
export function ChatView({ title }: { title: string }) {
  const t = TRANSCRIPTS[title] ?? TRANSCRIPTS['Design review pass']
  return (
    <div className="flex h-full min-h-0 flex-col items-center overflow-hidden px-6">
      <div className="flex w-full max-w-[640px] min-h-0 flex-1 flex-col gap-6 overflow-hidden pt-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 truncate text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
          <div className="flex min-w-0 items-center gap-2 text-fg-muted">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[#d9775733]">
              <Asterisk size={11} className="text-[#e8906e]" />
            </span>
            <span className="truncate">{t.meta}</span>
            <span className="ml-1 flex shrink-0 items-center gap-1.5 rounded-md bg-panel px-2 py-0.5 text-[11px]">
              <SquareTerminal size={12} /> 2 terminals
            </span>
          </div>
        </div>

        <div className="flex justify-end">
          <p className="m-0 max-w-[500px] rounded-2xl bg-muted px-3.5 py-2.5 text-[14px] leading-[1.55]">{t.prompt}</p>
        </div>

        <div className="flex flex-col gap-3">
          <button type="button" className="flex items-center gap-1.5 self-start text-fg-muted">
            {t.worked} <ChevronRight size={14} />
          </button>
          <p className="m-0 text-[14px] leading-[1.6]">{t.reply}</p>
          {t.change ? (
            <button type="button" className="flex items-center gap-2.5 rounded-xl bg-panel px-3.5 py-2.5 text-left">
              <FileDiff size={15} className="text-fg-muted" />
              Changed {t.change.files} file
              <span className="font-mono text-[12px] text-success">+{t.change.added}</span>
              <span className="font-mono text-[12px] text-destructive">−{t.change.removed}</span>
              <span className="flex-1" />
              <span className="text-fg-muted">Review</span>
              <ChevronRight size={14} className="text-fg-muted" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex w-full max-w-[640px] flex-col gap-2 pb-2 pt-2">
        <Composer />
      </div>
    </div>
  )
}
