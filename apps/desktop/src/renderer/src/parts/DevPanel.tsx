import { X } from 'lucide-react'
import { floors } from '../tokens'

type Theme = 'dark' | 'light'

interface Props {
  open: boolean
  onClose: () => void
  theme: Theme
  onTheme: (t: Theme) => void
  glass: boolean
  onGlass: (on: boolean) => void
  reduceTransparency: boolean
  transparency: number
  background: number
  onTransparency: (v: number) => void
  onBackground: (v: number) => void
  reducedMotion: boolean
  onReducedMotion: (on: boolean) => void
  fpsMeter: boolean
  onFpsMeter: (on: boolean) => void
  sideHide: 'slide' | 'cover'
  onSideHide: (mode: 'slide' | 'cover') => void
}

// Prototype-only developer panel for app-wide settings. Not part of the product design.
export function DevPanel(p: Props) {
  if (!p.open) return null
  const row = 'flex items-center justify-between gap-3'
  const percent = (v: number) => Math.round(v * 100)
  return (
    <aside className="no-drag fixed bottom-11 left-1/2 z-50 flex w-[320px] -translate-x-1/2 flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-overlay p-3.5 backdrop-blur-xl text-[12px] shadow-[0_16px_40px_#00000080]">
      <div className={row}>
        <strong className="text-[12px]">Dev panel</strong>
        <span className="flex-1 text-fg-muted">⌘. hides this</span>
        <button type="button" aria-label="Close dev panel" onClick={p.onClose} className="text-fg-muted">
          <X size={14} />
        </button>
      </div>
      <label className={row}>
        Theme
        <select
          value={p.theme}
          onChange={(e) => p.onTheme(e.target.value as Theme)}
          className="rounded bg-panel px-1.5 py-1"
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label className={row}>
        Glass (translucent window)
        <input type="checkbox" checked={p.glass} onChange={(e) => p.onGlass(e.target.checked)} />
      </label>
      {p.reduceTransparency ? (
        <p className="m-0 text-fg-muted">macOS Reduce transparency is on, so glass starts off.</p>
      ) : null}
      {p.glass ? (
        <>
          <label className={row}>
            Background {percent(p.background)}% opaque
            <input
              type="range"
              min={0}
              max={100}
              value={percent(p.background)}
              onChange={(e) => p.onBackground(Number(e.target.value) / 100)}
            />
          </label>
          <label className={row}>
            Pane transparency {percent(p.transparency)}%
            <input
              type="range"
              min={0}
              max={100}
              value={percent(p.transparency)}
              onChange={(e) => p.onTransparency(Number(e.target.value) / 100)}
            />
          </label>
          {/* 100% puts every pane at its contrast floor; the slider cannot go further. */}
          <p className="m-0 text-fg-muted">
            Floors:{' '}
            {floors(p.theme)
              .map((f) => `${f.surface} ${percent(f.floor)}%`)
              .join(' · ')}
          </p>
        </>
      ) : null}
      <label className={row}>
        Sidebar hide
        <select
          value={p.sideHide}
          onChange={(e) => p.onSideHide(e.target.value as 'slide' | 'cover')}
          className="rounded bg-panel px-1.5 py-1"
        >
          <option value="slide">Slide out</option>
          <option value="cover">Cover with panes</option>
        </select>
      </label>
      <label className={row}>
        Reduced motion
        <input type="checkbox" checked={p.reducedMotion} onChange={(e) => p.onReducedMotion(e.target.checked)} />
      </label>
      <label className={row}>
        Frame meter
        <input type="checkbox" checked={p.fpsMeter} onChange={(e) => p.onFpsMeter(e.target.checked)} />
      </label>
    </aside>
  )
}
