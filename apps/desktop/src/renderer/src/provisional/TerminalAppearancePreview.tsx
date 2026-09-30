import { useEffect, useRef, useState } from 'react'
import type { TerminalAppearance } from '@ade/contracts'
import { createTerminalPreview } from '@ade/terminal/preview'
import { FieldError } from '@/components/ui/field'
import { previewTerminalTheme } from './appearance-preview'

/** Local sample only: no terminal attachment, input bridge or durable state. */
export function TerminalAppearancePreview({ appearance }: { appearance: TerminalAppearance }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<Awaited<ReturnType<typeof createTerminalPreview>> | null>(null)
  const currentTheme = useRef(previewTerminalTheme(appearance))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    currentTheme.current = previewTerminalTheme(appearance)
    view.current?.setTheme(currentTheme.current)
  }, [appearance])
  useEffect(() => {
    let disposed = false
    void createTerminalPreview(currentTheme.current)
      .then((created) => {
        if (disposed) {
          created.dispose()
          return
        }
        created.setTheme(currentTheme.current)
        view.current = created
        host.current!.append(created.canvas)
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      disposed = true
      view.current?.dispose()
      view.current = null
    }
  }, [])
  return (
    <>
      <div ref={host} />
      {error && <FieldError>Terminal sample could not be loaded: {error}</FieldError>}
    </>
  )
}
