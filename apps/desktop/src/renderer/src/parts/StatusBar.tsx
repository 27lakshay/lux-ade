import { Gauge, GitBranch } from 'lucide-react'

export function StatusBar() {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 bg-status px-3.5 text-[11px] text-fg-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> This Mac · up to date
      </span>
      <span className="flex items-center gap-1.5">
        <Gauge size={12} /> Claude 58% of 5h · Codex 12% of week
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> desktop listening on :5173
      </span>
      <span className="flex items-center gap-1.5">
        <GitBranch size={12} /> main ↑3
      </span>
    </footer>
  )
}
