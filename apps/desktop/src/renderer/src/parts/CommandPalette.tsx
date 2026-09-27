import { useEffect, useRef, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Command } from 'cmdk'
import { Check } from 'lucide-react'

export interface PaletteCommand {
  id: string
  group: string
  label: string
  shortcut?: string
  // Extra search words, e.g. "hide" for "Toggle left sidebar".
  keywords?: string[]
  icon?: ComponentType<{ size?: number; className?: string }>
  // Shows a check: the command names the current state (e.g. the active theme).
  checked?: boolean
  run: () => void
}

// Ranks commands by how the search appears in them, not by scattered letters: cmdk's default
// fuzzy score let "swap" match "Open Design review pass" (s…w…a…p) above "Swap sidebars".
// Every search word must match: at the start of a word in the item (strongest), inside a word,
// or as the start of a keyword.
function rank(value: string, search: string, keywords?: string[]): number {
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  const text = value.toLowerCase()
  const tokens = text.split(/[^a-z0-9]+/)
  const keys = (keywords ?? []).map((k) => k.toLowerCase())
  let score = 1
  for (const w of words) {
    if (tokens.some((t) => t.startsWith(w))) score *= 1
    else if (text.includes(w)) score *= 0.6
    else if (keys.some((k) => k.startsWith(w))) score *= 0.4
    else return 0
  }
  return score
}

// ⌘⇧P palette. Opening is a high-frequency action, so it appears in 120ms with a small settle and
// no travel; reduced motion makes it a plain fade. It sits on a light scrim above everything, and
// window-drag regions are switched off while it is open so every click reaches it.
export function CommandPalette(p: { open: boolean; onClose: () => void; commands: PaletteCommand[]; reduced: boolean }) {
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!p.open) return
    returnFocus.current = document.activeElement as HTMLElement | null
    document.documentElement.dataset.dragging = 'palette'
    return () => {
      delete document.documentElement.dataset.dragging
      // Give focus back unless the command moved it somewhere on purpose.
      if (document.activeElement === document.body) returnFocus.current?.focus()
    }
  }, [p.open])

  const groups = [...new Set(p.commands.map((c) => c.group))]
  const settle = p.reduced ? {} : { scale: 0.98 }

  return createPortal(
    <AnimatePresence>
      {p.open ? (
        <motion.div
          key="palette"
          className="fixed inset-0 z-[60] bg-black/20"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onPointerDown={p.onClose}
        >
          <motion.div
            className="absolute inset-x-0 top-[14vh] mx-auto w-[min(640px,calc(100vw-32px))]"
            initial={{ opacity: 0, ...settle }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, ...settle, transition: { duration: 0.1 } }}
            transition={{ duration: 0.12, ease: [0.25, 1, 0.5, 1] }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Command
              label="Command palette"
              loop
              filter={rank}
              className="overflow-hidden rounded-xl bg-overlay text-fg shadow-[0_24px_64px_#00000073,0_2px_8px_#00000040] backdrop-blur-xl"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  p.onClose()
                }
              }}
            >
              <Command.Input
                autoFocus
                placeholder="Type a command or search…"
                className="h-12 w-full bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-fg-muted focus-visible:outline-none"
              />
              <Command.List className="max-h-[min(400px,60vh)] overflow-y-auto overscroll-contain px-1.5 pb-1.5">
                <Command.Empty className="px-3 py-8 text-center text-fg-muted">No matching commands</Command.Empty>
                {groups.map((group) => (
                  <Command.Group
                    key={group}
                    heading={group}
                    className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-muted"
                  >
                    {p.commands
                      .filter((c) => c.group === group)
                      .map((c) => {
                        const Icon = c.icon
                        return (
                          <Command.Item
                            key={c.id}
                            value={`${c.group} ${c.label}`}
                            keywords={c.keywords}
                            onSelect={() => {
                              p.onClose()
                              c.run()
                            }}
                            className="flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] data-[selected=true]:bg-selected"
                          >
                            <span className="flex w-4 shrink-0 justify-center text-fg-muted">
                              {Icon ? <Icon size={15} /> : null}
                            </span>
                            <span className="flex-1 truncate">{c.label}</span>
                            {c.checked ? <Check size={14} className="text-fg-muted" /> : null}
                            {c.shortcut ? <kbd className="font-sans text-[11px] text-fg-muted">{c.shortcut}</kbd> : null}
                          </Command.Item>
                        )
                      })}
                  </Command.Group>
                ))}
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
