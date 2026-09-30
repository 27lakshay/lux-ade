import { useEffect, useRef, useState } from 'react'
import type { BuiltinPalette, TerminalAppearance } from '@ade/contracts'
import type { Highlighter } from 'shiki'
import type { FileDiff } from '@pierre/diffs'
import { FieldError } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { adeCodeTheme, applyCodeTheme } from '../features/code/code-theme'
import { applyPierreTheme, pierreThemeCSS, registerPierreTheme } from '../features/code/pierre-theme'
import { TerminalAppearancePreview } from './TerminalAppearancePreview'

export function AppearancePreviewSample({
  app,
  syntax,
  terminal,
  terminal_name,
}: {
  app: BuiltinPalette
  syntax: BuiltinPalette
  terminal: TerminalAppearance
  terminal_name: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const code = useRef<HTMLDivElement>(null)
  const diffHost = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    for (const [role, value] of Object.entries(app.tokens)) root.current!.style.setProperty(`--${role}`, value)
    root.current!.style.colorScheme = app.mode
    applyCodeTheme(code.current!, syntax.tokens)
    applyCodeTheme(diffHost.current!, syntax.tokens)
  }, [app, syntax, terminal])
  useEffect(() => {
    let disposed = false
    let highlighter: Highlighter | undefined
    let diff: FileDiff | undefined
    const report = (failure: unknown) => {
      if (!disposed) setError(failure instanceof Error ? failure.message : String(failure))
    }
    void import('shiki')
      .then(({ createHighlighter }) => createHighlighter({ themes: [adeCodeTheme], langs: ['javascript'] }))
      .then((created) => {
        if (disposed) {
          created.dispose()
          return
        }
        highlighter = created
        code.current!.innerHTML = created.codeToHtml('// Readable code\nconst answer = "hello";\nconst count = 42;', {
          lang: 'javascript',
          theme: adeCodeTheme.name!,
        })
      })
      .catch(report)
    void Promise.all([registerPierreTheme(), import('@pierre/diffs')])
      .then(([theme, { FileDiff }]) => {
        if (disposed) return
        applyPierreTheme(diffHost.current!)
        diff = new FileDiff({
          theme,
          unsafeCSS: pierreThemeCSS,
          diffStyle: 'unified',
          disableFileHeader: true,
          lineDiffType: 'word',
        })
        diff.render({
          oldFile: { name: 'sample.js', contents: 'const answer = 10;\n' },
          newFile: { name: 'sample.js', contents: 'const answer = 42;\n' },
          containerWrapper: diffHost.current!,
        })
      })
      .catch(report)
    return () => {
      disposed = true
      highlighter?.dispose()
      diff?.cleanUp()
    }
  }, [])
  return (
    <div
      ref={root}
      data-appearance-preview={app.mode}
      className={
        'flex flex-col gap-4 rounded-md bg-background p-4 text-foreground' + (app.mode === 'dark' ? ' dark' : '')
      }
    >
      <Card size="sm">
        <CardHeader>
          <CardTitle>
            {app.mode === 'light' ? 'Light' : 'Dark'} — {app.name}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" data-testid="appearance-primary">
              Primary action
            </Button>
            <Button size="sm" variant="secondary">
              Secondary action
            </Button>
            <Button size="sm" variant="outline" data-testid="appearance-outline">
              Outline action
            </Button>
            <Toggle size="sm" data-testid="appearance-toggle" aria-label="Preview toggle">
              Toggle option
            </Toggle>
            <Button size="sm" variant="destructive" data-testid="appearance-destructive">
              Destructive sample
            </Button>
          </div>
        </CardContent>
      </Card>
      <div>
        Code and diff: {syntax.name} ({syntax.mode})
      </div>
      <div ref={code} data-testid="appearance-code" />
      <div ref={diffHost} data-testid="appearance-diff" />
      <div>
        Terminal: {terminal_name} ({terminal.dark ? 'dark' : 'light'})
      </div>
      <TerminalAppearancePreview appearance={terminal} />
      {error && <FieldError>Sample could not be loaded: {error}</FieldError>}
    </div>
  )
}
