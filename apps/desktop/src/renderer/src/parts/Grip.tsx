import type { PointerEvent as ReactPointerEvent } from 'react'

// Drag handle at the bottom edge of a card (panes and sidebars). It never takes focus on press.
export function Grip({ label, onDragStart }: { label: string; onDragStart: (e: ReactPointerEvent) => void }) {
  return (
    <div className="flex h-3.5 shrink-0 items-center justify-center">
      <button
        type="button"
        aria-label={label}
        onPointerDown={(e) => {
          e.preventDefault()
          onDragStart(e)
        }}
        className="group flex h-3.5 w-12 cursor-grab items-center justify-center active:cursor-grabbing"
      >
        <span className="h-1 w-8 rounded-full bg-[var(--border)] transition-[width,background-color] duration-150 group-hover:w-10 group-hover:bg-fg-muted" />
      </button>
    </div>
  )
}
