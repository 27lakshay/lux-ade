import { useState } from 'react'
import type { PaletteMode } from '@ade/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Body } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { deriveSimpleTheme } from './simple-theme'

export function ThemeValidationPanel({ initialSource = '' }: { initialSource?: string }) {
  const cache = useQueryClient()
  const [source, setSource] = useState(initialSource)
  const [themeId, setThemeId] = useState('user:generated')
  const [themeName, setThemeName] = useState('Generated theme')
  const [mode, setMode] = useState<PaletteMode>('dark')
  const [surface, setSurface] = useState('#20242a')
  const [accent, setAccent] = useState('#5479bd')
  const [generationError, setGenerationError] = useState<string | undefined>()
  const validation = useMutation({ mutationFn: (text: string) => window.adeHost.themes.validate(text) })
  const installation = useMutation({
    mutationFn: ({ text, revision }: { text: string; revision: number }) =>
      window.adeHost.themes.install([{ source: text, expected_revision: revision }]),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['theme-library'] })
      void cache.invalidateQueries({ queryKey: ['theme-record'] })
    },
  })
  const report = validation.variables === source ? validation.data : undefined
  const protectedTarget =
    report?.target?.bundled ||
    report?.definition?.provenance.kind === 'bundled' ||
    report?.definition?.provenance.kind === 'plugin' ||
    /^(ade|plugin(?:\.[^:]+)?):/.test(report?.definition?.id ?? '')
  const installed = installation.variables?.text === source && installation.data?.committed

  function generate() {
    try {
      const definition = deriveSimpleTheme({ id: themeId, name: themeName, mode, surface, accent })
      setSource(JSON.stringify(definition, null, 2))
      setGenerationError(undefined)
      validation.reset()
      installation.reset()
    } catch (error) {
      validation.reset()
      installation.reset()
      setGenerationError(error instanceof Error ? error.message : 'Could not generate a theme draft.')
    }
  }

  return (
    <section aria-labelledby="simple-theme-heading" className="space-y-4 rounded-lg bg-card p-4">
      <FieldSet>
        <FieldLegend id="simple-theme-heading">Generate a simple theme draft</FieldLegend>
        <FieldDescription>
          Choose opaque surface and accent colors. Generated colors are suggestions, not an accessibility certification.
        </FieldDescription>
        <FieldGroup className="grid grid-cols-1 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="simple-theme-id">Theme ID</FieldLabel>
            <Input id="simple-theme-id" value={themeId} onChange={(event) => setThemeId(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="simple-theme-name">Theme name</FieldLabel>
            <Input id="simple-theme-name" value={themeName} onChange={(event) => setThemeName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="simple-theme-mode">Mode</FieldLabel>
            <select
              id="simple-theme-mode"
              className="h-9 rounded-md bg-background px-3"
              value={mode}
              onChange={(event) => setMode(event.target.value as PaletteMode)}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="simple-theme-surface">Surface color</FieldLabel>
            <Input id="simple-theme-surface" value={surface} onChange={(event) => setSurface(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="simple-theme-accent">Accent color</FieldLabel>
            <Input id="simple-theme-accent" value={accent} onChange={(event) => setAccent(event.target.value)} />
          </Field>
        </FieldGroup>
        <Button size="sm" disabled={validation.isPending || installation.isPending} onClick={generate}>
          Generate app theme draft
        </Button>
        {generationError && <FieldError role="alert">{generationError}</FieldError>}
      </FieldSet>
      <Field>
        <FieldLabel htmlFor="theme-source">ADE theme definition</FieldLabel>
        <FieldDescription>
          Validate JSON or JSONC before importing a theme. Validation keeps appearance unchanged.
        </FieldDescription>
        <Textarea
          id="theme-source"
          value={source}
          rows={6}
          disabled={installation.isPending}
          onChange={(event) => {
            setSource(event.target.value)
            validation.reset()
            installation.reset()
            setGenerationError(undefined)
          }}
          spellCheck={false}
          className="min-h-52"
        />
        <Button
          size="sm"
          disabled={validation.isPending || installation.isPending}
          onClick={() => validation.mutate(source)}
        >
          Validate theme
        </Button>
        {validation.variables === source && validation.error && <FieldError>{validation.error.message}</FieldError>}
        {installation.error && (
          <FieldError>{installation.error.message} Validate again to review the current target revision.</FieldError>
        )}
        {installed && (
          <Body role="status">
            Theme installed at library revision {installation.data?.revision}. Selected sections use this definition.
          </Body>
        )}
        {report && (
          <div role="status" aria-live="polite">
            <Body>{report.valid ? 'Theme definition is valid.' : 'Theme definition has errors.'}</Body>
            {report.definition && (
              <Body>
                {report.definition.name} — {report.definition.id}
              </Body>
            )}
            {report.target && (
              <Body>
                Existing ID: {report.target.id} — {report.target.name}, revision {report.target.revision}. Replacement
                requires this revision.
              </Body>
            )}
            {protectedTarget && (
              <Body>
                This definition is protected. Create a custom draft with a distinct ID from the theme library.
              </Body>
            )}
            {report.valid && !protectedTarget && !installed && (
              <Button
                size="sm"
                disabled={installation.isPending}
                onClick={() => installation.mutate({ text: source, revision: report.target?.revision ?? 0 })}
              >
                {report.target ? 'Replace theme' : 'Install theme'}
              </Button>
            )}
            <ul>
              {report.diagnostics.map((diagnostic, index) => (
                <li key={index}>
                  {diagnostic.severity}: {diagnostic.path || 'Document'}, line {diagnostic.line}, column{' '}
                  {diagnostic.column}: {diagnostic.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Field>
    </section>
  )
}
