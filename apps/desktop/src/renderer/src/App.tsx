// oxlint-disable react/immutability -- prototype shell, not yet approved; fix when rebuilt against the Pen design
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowLeftRight,
  Columns2,
  Gauge,
  Layers,
  MessageSquare,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  SlidersHorizontal,
  SquarePen,
  Sun,
  Undo2,
  Wind,
  X,
} from 'lucide-react'
import { DEFAULT_SETTINGS, panelTransition, type MotionSettings } from './motion'
import { Sidebar } from './parts/Sidebar'
import { Panes, type PanesHandle } from './panes/Panes'
import { CommandPalette } from './parts/CommandPalette'
import { ChangesPanel } from './parts/ChangesPanel'
import { StatusBar } from './parts/StatusBar'
import { DevPanel } from './parts/DevPanel'
import { FpsMeter } from './parts/FpsMeter'
import { IconButton } from './parts/IconButton'
import { applyTokens, DEFAULT_GLASS, DEFAULT_THEME, REDUCED_TRANSPARENCY } from './tokens'
import { usePersistentState } from './persist'

import {
  GUTTER,
  LEADING_SLOT,
  LEFT_W,
  RIGHT_TOGGLE_INSET,
  RIGHT_W,
  SIDEBAR_TOGGLE_X,
  TOGGLE_SIZE,
  TOGGLE_TOP,
} from './layout'
import { Grip } from './parts/Grip'
import { LAYOUT_SPRING } from './panes/Pane'

const ENGINE_PARAM = new URLSearchParams(location.search).get('engine')

type SideName = 'left' | 'right'
type SideHide = 'slide' | 'cover'
type SidePanel = 'sessions' | 'changes'
const SIDE_W: Record<SidePanel, number> = { sessions: LEFT_W, changes: RIGHT_W }
const SIDE_LABEL: Record<SidePanel, string> = { sessions: 'Sessions', changes: 'Changes' }
// Peek timing: a short rest before showing (so passing through an edge doesn't flash it), and a
// grace period before hiding (so moving from the edge or toggle onto the sidebar keeps it).
const PEEK_SHOW_DELAY = 80
const PEEK_HIDE_DELAY = 300
// Sidebars glide to their new sides on the same spring as panes after a drop.
const SIDE_SWAP = LAYOUT_SPRING
interface SideDrag {
  from: SideName
  label: string
  preview: { left: number; top: number; width: number; height: number } | null
  ghostX: number
  ghostY: number
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => matchMedia(query).matches,
  )
}

export function App() {
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  // Dev-panel settings persist across relaunches (persist.ts). Reduced motion and glass follow the
  // macOS settings until the panel overrides them; the override is what persists.
  const [theme, setTheme] = usePersistentState<'dark' | 'light'>('theme', DEFAULT_THEME)
  const [fpsMeter, setFpsMeter] = usePersistentState('fpsMeter', true)
  const [reducedOverride, setReducedOverride] = usePersistentState<boolean | null>('reducedMotion', null)
  const [glassOverride, setGlassOverride] = usePersistentState<boolean | null>('glass', null)
  const [glassTuning, setGlassTuning] = usePersistentState('glassTuning', DEFAULT_GLASS)
  const [devOpen, setDevOpen] = useState(true)

  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const reduceTransparency = useMediaQuery(REDUCED_TRANSPARENCY)
  const glassOn = glassOverride ?? !reduceTransparency
  const settings: MotionSettings = {
    ...DEFAULT_SETTINGS,
    reduced: reducedOverride ?? reduceMotion,
    // ?engine=spring lets the profiling modes pick an engine.
    ...(ENGINE_PARAM === 'spring' || ENGINE_PARAM === 'tween' ? { engine: ENGINE_PARAM } : {}),
  }

  useLayoutEffect(() => {
    applyTokens(theme, { on: glassOn, ...glassTuning })
  }, [theme, glassOn, glassTuning])
  useEffect(() => {
    window.adeHost.setTheme(theme)
  }, [theme])

  // Peek: while a sidebar is hidden, resting the pointer on its window edge or its title-bar toggle
  // floats it over the panes without resizing anything. It hides again shortly after the
  // pointer leaves it, or on Escape; toggling (click or ⌘B) pins it open for real. `raised` keeps
  // it above the panes until its exit motion has finished, so it never vanishes under it.
  const [peek, setPeek] = useState<Record<SideName, boolean>>({ left: false, right: false })
  const [raised, setRaised] = useState<Record<SideName, boolean>>({ left: false, right: false })
  const peekTimers = useRef<Partial<Record<SideName, ReturnType<typeof setTimeout>>>>({})
  const schedulePeek = useCallback((side: SideName, show: boolean, delay: number) => {
    clearTimeout(peekTimers.current[side])
    peekTimers.current[side] = setTimeout(() => {
      if (show) setRaised((r) => ({ ...r, [side]: true }))
      setPeek((p) => (p[side] === show ? p : { ...p, [side]: show }))
    }, delay)
  }, [])
  const holdPeek = (side: SideName) => clearTimeout(peekTimers.current[side])
  const endPeek = useCallback((side: SideName) => {
    clearTimeout(peekTimers.current[side])
    setPeek((p) => (p[side] ? { ...p, [side]: false } : p))
  }, [])

  const toggleLeft = useCallback(() => {
    endPeek('left')
    setLeftOpen((v) => !v)
  }, [endPeek])
  const toggleRight = useCallback(() => {
    endPeek('right')
    setRightOpen((v) => !v)
  }, [endPeek])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        endPeek('left')
        endPeek('right')
      }
      if (e.metaKey && e.code === 'KeyB') {
        e.preventDefault()
        // A held shortcut auto-repeats; only the first press toggles.
        if (e.repeat) return
        if (e.altKey) toggleRight()
        else toggleLeft()
      }
      if (e.metaKey && e.code === 'Period') {
        e.preventDefault()
        setDevOpen((v) => !v)
      }
      if (e.metaKey && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault()
        if (!e.repeat) setPaletteOpen((v) => !v)
      }
      // Pane shortcuts the palette also lists. (⌘W is left alone: Electron's default menu
      // binds it to closing the window.)
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.repeat) {
        if (e.code === 'KeyT') {
          e.preventDefault()
          panes.current?.newTab()
        } else if (e.code === 'Backslash') {
          e.preventDefault()
          panes.current?.splitRight()
        } else if (e.code === 'KeyN') {
          e.preventDefault()
          newConversation()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleLeft, toggleRight, endPeek])

  const swapSides = () => {
    setSides((s) => ({ left: s.right, right: s.left }))
    // Visibility travels with the panel.
    setLeftOpen(rightOpen)
    setRightOpen(leftOpen)
  }

  const [paletteOpen, setPaletteOpen] = useState(false)
  const panes = useRef<PanesHandle>(null)
  const chatCount = useRef(0)
  const newConversation = () => panes.current?.openChat(`New chat ${++chatCount.current}`)

  const layout = panelTransition(settings)

  // The two sidebars can trade sides by their grips. Each keeps its own width and its own
  // visibility; the arrangement persists with the dev-panel settings.
  const [sides, setSides] = usePersistentState<Record<SideName, SidePanel>>('sidebarSides', {
    left: 'sessions',
    right: 'changes',
  })
  const cardEls = useRef<Record<SideName, HTMLElement | null>>({ left: null, right: null })
  const [sideDrag, setSideDrag] = useState<SideDrag | null>(null)
  const [sideHide, setSideHide] = usePersistentState<SideHide>('sidebarHide', 'slide')

  const startSideDrag = (e: ReactPointerEvent, from: SideName) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const panel = sides[from]
    let active = false
    let across = false

    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
        active = true
        document.documentElement.dataset.dragging = 'pane'
      }
      // Past the window's middle, the panel belongs on the other side. The preview shows it there
      // at its own width.
      across = from === 'left' ? ev.clientX > innerWidth / 2 : ev.clientX < innerWidth / 2
      const card = cardEls.current[from]!.getBoundingClientRect()
      const width = SIDE_W[panel]
      const preview = across
        ? { left: from === 'left' ? innerWidth - GUTTER - width : GUTTER, top: card.top, width, height: card.height }
        : null
      setSideDrag({ from, label: SIDE_LABEL[panel], preview, ghostX: ev.clientX - 24, ghostY: ev.clientY - 18 })
    }
    const end = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
      delete document.documentElement.dataset.dragging
      setSideDrag(null)
    }
    const onUp = () => {
      if (active && across) swapSides()
      end()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      end()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  // Each side is a slot and a card. The slot's width makes room in the layout. How the card hides
  // is a dev-panel choice:
  //   slide  the full-size card slides by exactly the slot's change on the same transition, so its
  //          inner edge stays glued to the panes and it leaves by the window edge.
  //   cover  the card stays put, under the panes, whose edge slides over it; the card fades as
  //          it is covered so it never shows through translucent (glass) panes.
  // When the sidebars trade sides, each card glides to its new slot (shared layoutId).
  // A peeking sidebar sits in its slot position but floats above the panes, opaque and with a
  // deeper shadow, because it covers live content. (A blurred translucent surface was tried; the
  // blur did not apply there, so the text underneath read through.)
  const renderSide = (side: SideName, open: boolean) => {
    const panel = sides[side]
    const width = SIDE_W[panel]
    const slot = width + GUTTER
    const other = side === 'left' ? 'right' : 'left'
    const peeking = peek[side] && !open
    const shown = open || peeking
    return (
      <motion.div
        className="relative shrink-0"
        data-part={side === 'left' ? 'left-card' : undefined}
        // Raised above the panes while peeking, and still while a pinned peek's slot opens, so
        // the panes shrink behind the sidebar rather than passing over it.
        style={{ zIndex: raised[side] ? 20 : undefined }}
        initial={false}
        animate={{ width: open ? slot : 0 }}
        transition={layout}
        onAnimationComplete={() => {
          if (!peek[side]) setRaised((r) => (r[side] ? { ...r, [side]: false } : r))
        }}
      >
        {/* Outer: an invisible frame that only carries the shared-layout glide when the sidebars
            trade sides. That glide works through its own transforms, so the visible card's slide
            and fade live on the inner element, where nothing competes with them. */}
        <motion.div
          key={panel}
          layoutId={`side-${panel}`}
          ref={(el: HTMLDivElement | null) => {
            cardEls.current[side] = el
          }}
          className={`absolute inset-y-0 ${side === 'left' ? 'left-0' : 'right-0'}`}
          style={{ width }}
          transition={{ layout: SIDE_SWAP }}
          aria-hidden={!shown}
          inert={!shown}
          onPointerEnter={() => peeking && holdPeek(side)}
          onPointerLeave={() => peeking && schedulePeek(side, false, PEEK_HIDE_DELAY)}
        >
          {/* The card. Hiding slides it out, or leaves it under the panes in cover mode, where
              it also fades so it never shows through translucent panes. It dims while dragged. */}
          <motion.div
            className="card flex h-full flex-col"
            // The floating look (opaque, deep shadow) holds for as long as the card is raised over
            // the panes, including while a pinned peek's panes shrink behind it, then
            // eases into the normal card.
            style={{
              transition: 'box-shadow 300ms ease, background-color 300ms ease',
              ...(raised[side]
                ? {
                    ['--card-bg' as string]: 'var(--side-solid)',
                    boxShadow: '0 24px 64px #00000073, 0 2px 8px #00000040',
                  }
                : {}),
            }}
            initial={false}
            animate={{
              x: shown || sideHide === 'cover' ? 0 : side === 'left' ? -slot : slot,
              opacity: (sideHide === 'cover' && !shown ? 0 : 1) * (sideDrag?.from === side ? 0.4 : 1),
            }}
            onAnimationComplete={() => {
              if (!peek[side]) setRaised((r) => (r[side] ? { ...r, [side]: false } : r))
            }}
            // The panel spring stops within 1px: right for the slide, but coarser than the whole
            // 0..1 opacity change, which would then snap. The fade gets a fine rest threshold.
            transition={{
              ...layout,
              opacity: sideDrag ? { duration: 0.15 } : { ...layout, restDelta: 0.005, restSpeed: 0.05 },
            }}
          >
            <div className="min-h-0 flex-1">{panel === 'sessions' ? <Sidebar /> : <ChangesPanel side={side} />}</div>
            <Grip label={`Move ${SIDE_LABEL[panel]} to the ${other}`} onDragStart={(e) => startSideDrag(e, side)} />
          </motion.div>
        </motion.div>
      </motion.div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1" style={{ padding: `${GUTTER}px ${GUTTER}px ${GUTTER}px` }}>
        {renderSide('left', leftOpen)}

        {/* The panes sit above the sidebars, so in cover mode their edge slides over them. */}
        <div className="relative z-10 flex min-w-0 flex-1">
          <Panes
            ref={panes}
            // With a sidebar closed, the top corner panes' strips leave room under the window-level
            // toggles.
            leading={
              <motion.div
                className="shrink-0"
                initial={false}
                animate={{ width: leftOpen ? 0 : LEADING_SLOT }}
                transition={layout}
              />
            }
            trailing={
              <motion.div
                className="shrink-0"
                initial={false}
                animate={{ width: rightOpen ? 0 : TOGGLE_SIZE + 4 }}
                transition={layout}
              />
            }
          />
        </div>

        {renderSide('right', rightOpen)}
      </div>

      {/* Sidebar swap: a preview on the other side, and a small card following the pointer. */}
      <AnimatePresence>
        {sideDrag?.preview ? (
          <motion.div
            key="side-preview"
            className="pointer-events-none fixed z-40 rounded-xl bg-muted"
            initial={{ opacity: 0, ...sideDrag.preview }}
            animate={{ opacity: 1, ...sideDrag.preview }}
            exit={{ opacity: 0 }}
            transition={{ opacity: { duration: 0.12 } }}
          />
        ) : null}
      </AnimatePresence>
      {sideDrag ? (
        <div
          className="pointer-events-none fixed left-0 top-0 z-50"
          style={{ transform: `translate(${sideDrag.ghostX}px, ${sideDrag.ghostY}px)` }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.12 }}
            className="flex h-9 items-center rounded-xl bg-overlay px-3.5 text-[12px] font-medium text-fg shadow-[0_12px_32px_#00000066] backdrop-blur-xl"
          >
            {sideDrag.label}
          </motion.div>
        </div>
      ) : null}

      {/* Title-bar controls: fixed to the window in the traffic lights' row, owned by no card, so
          they stay put while the sidebars move under them. Layer 30: above the panes (10) and
          sidebars, below drag previews (40) and dragged cards (50). */}
      {/* Hovering a hidden side's toggle peeks that sidebar. */}
      <div
        className="no-drag fixed z-30"
        style={{ left: SIDEBAR_TOGGLE_X, top: TOGGLE_TOP }}
        onPointerEnter={() => !leftOpen && schedulePeek('left', true, PEEK_SHOW_DELAY)}
        onPointerLeave={() => !leftOpen && schedulePeek('left', false, PEEK_HIDE_DELAY)}
      >
        <IconButton
          label={`${leftOpen ? 'Hide' : 'Show'} sidebar (⌘B)`}
          pressed={leftOpen}
          onClick={() => toggleLeft()}
        >
          <PanelLeft size={16} />
        </IconButton>
      </div>
      <div
        className="no-drag fixed z-30"
        style={{ right: RIGHT_TOGGLE_INSET, top: TOGGLE_TOP }}
        onPointerEnter={() => !rightOpen && schedulePeek('right', true, PEEK_SHOW_DELAY)}
        onPointerLeave={() => !rightOpen && schedulePeek('right', false, PEEK_HIDE_DELAY)}
      >
        <IconButton
          label={`${rightOpen ? 'Hide' : 'Show'} side panel (⌥⌘B)`}
          pressed={rightOpen}
          onClick={() => toggleRight()}
        >
          <PanelRight size={16} />
        </IconButton>
      </div>

      {/* Edge strips: resting the pointer against a hidden side's window edge peeks that sidebar.
          They cover only the outer gutter, never pane content. */}
      {(['left', 'right'] as const).map((side) =>
        (side === 'left' ? leftOpen : rightOpen) ? null : (
          <div
            key={`edge-${side}`}
            aria-hidden
            className={`fixed inset-y-0 z-30 ${side === 'left' ? 'left-0' : 'right-0'}`}
            style={{ width: GUTTER }}
            onPointerEnter={() => schedulePeek(side, true, PEEK_SHOW_DELAY)}
            onPointerLeave={() => schedulePeek(side, false, PEEK_HIDE_DELAY)}
          />
        ),
      )}

      <StatusBar />
      {fpsMeter ? <FpsMeter /> : null}

      <DevPanel
        open={devOpen}
        onClose={() => setDevOpen(false)}
        theme={theme}
        onTheme={setTheme}
        glass={glassOn}
        onGlass={setGlassOverride}
        reduceTransparency={reduceTransparency}
        transparency={glassTuning.transparency}
        background={glassTuning.background}
        onTransparency={(transparency) => setGlassTuning((g) => ({ ...g, transparency }))}
        onBackground={(background) => setGlassTuning((g) => ({ ...g, background }))}
        reducedMotion={settings.reduced}
        onReducedMotion={setReducedOverride}
        fpsMeter={fpsMeter}
        onFpsMeter={setFpsMeter}
        sideHide={sideHide}
        onSideHide={setSideHide}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        reduced={settings.reduced}
        commands={[
          {
            id: 'new-chat',
            group: 'Sessions',
            label: 'New conversation',
            shortcut: '⌘N',
            icon: SquarePen,
            run: newConversation,
          },
          ...['Design review pass', 'Packaging E2E', 'Service ports', 'Notes cleanup'].map((title) => ({
            id: `open-${title}`,
            group: 'Sessions',
            label: `Open ${title}`,
            keywords: ['session', 'chat', 'go to'],
            icon: MessageSquare,
            run: () => panes.current?.openChat(title),
          })),
          {
            id: 'new-tab',
            group: 'Panes',
            label: 'New tab',
            shortcut: '⌘T',
            icon: Plus,
            run: () => panes.current?.newTab(),
          },
          {
            id: 'split',
            group: 'Panes',
            label: 'Split pane right',
            shortcut: '⌘\\',
            icon: Columns2,
            run: () => panes.current?.splitRight(),
          },
          { id: 'close-tab', group: 'Panes', label: 'Close tab', icon: X, run: () => panes.current?.closeTab() },
          {
            id: 'undo',
            group: 'Panes',
            label: 'Undo layout change',
            shortcut: '⌘Z',
            icon: Undo2,
            run: () => panes.current?.undo(),
          },
          {
            id: 'left',
            group: 'View',
            label: `${leftOpen ? 'Hide' : 'Show'} left sidebar`,
            shortcut: '⌘B',
            keywords: ['toggle', 'panel'],
            icon: PanelLeft,
            run: toggleLeft,
          },
          {
            id: 'right',
            group: 'View',
            label: `${rightOpen ? 'Hide' : 'Show'} right sidebar`,
            shortcut: '⌥⌘B',
            keywords: ['toggle', 'panel', 'changes'],
            icon: PanelRight,
            run: toggleRight,
          },
          {
            id: 'swap',
            group: 'View',
            label: 'Swap sidebars',
            keywords: ['move', 'sides'],
            icon: ArrowLeftRight,
            run: swapSides,
          },
          {
            id: 'hide-slide',
            group: 'View',
            label: 'Sidebar hide: slide out',
            checked: sideHide === 'slide',
            run: () => setSideHide('slide'),
          },
          {
            id: 'hide-cover',
            group: 'View',
            label: 'Sidebar hide: cover with panes',
            checked: sideHide === 'cover',
            run: () => setSideHide('cover'),
          },
          {
            id: 'dark',
            group: 'Appearance',
            label: 'Dark theme',
            checked: theme === 'dark',
            icon: Moon,
            run: () => setTheme('dark'),
          },
          {
            id: 'light',
            group: 'Appearance',
            label: 'Light theme',
            checked: theme === 'light',
            icon: Sun,
            run: () => setTheme('light'),
          },
          {
            id: 'glass',
            group: 'Appearance',
            label: glassOn ? 'Turn glass off' : 'Turn glass on',
            keywords: ['transparency', 'blur'],
            icon: Layers,
            run: () => setGlassOverride(!glassOn),
          },
          {
            id: 'dev',
            group: 'Developer',
            label: `${devOpen ? 'Hide' : 'Show'} dev panel`,
            shortcut: '⌘.',
            icon: SlidersHorizontal,
            run: () => setDevOpen((v) => !v),
          },
          {
            id: 'fps',
            group: 'Developer',
            label: `${fpsMeter ? 'Hide' : 'Show'} frame meter`,
            keywords: ['fps'],
            icon: Gauge,
            run: () => setFpsMeter(!fpsMeter),
          },
          {
            id: 'reduced',
            group: 'Developer',
            label: `${settings.reduced ? 'Turn off' : 'Turn on'} reduced motion`,
            keywords: ['animation'],
            icon: Wind,
            run: () => setReducedOverride(!settings.reduced),
          },
        ]}
      />
    </div>
  )
}
