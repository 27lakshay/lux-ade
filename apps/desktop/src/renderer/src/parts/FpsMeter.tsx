import { useEffect, useRef } from 'react'

// Prototype-only frame meter: frames drawn in the last second. It writes to the DOM directly so
// measuring never re-renders React.
export function FpsMeter() {
  const fpsRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    const recent: number[] = []
    let lastPaint = 0
    const tick = (now: number) => {
      recent.push(now)
      while (recent.length && now - recent[0] > 1000) recent.shift()
      if (now - lastPaint > 200) {
        lastPaint = now
        if (fpsRef.current) fpsRef.current.textContent = String(recent.length)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-[21px] z-50 -translate-x-1/2 rounded-md bg-overlay px-2.5 py-1 font-mono text-[11px] text-fg-muted shadow-[0_4px_12px_#0000004d] backdrop-blur-xl"
      aria-hidden
    >
      <span ref={fpsRef} className="text-fg">
        –
      </span>{' '}
      fps
    </div>
  )
}
