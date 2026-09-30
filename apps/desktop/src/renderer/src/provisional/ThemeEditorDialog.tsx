import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PaletteMode, ThemeDefinition, ThemeDraftPreview } from '@ade/contracts'
import { Caption } from '@/components/Typography'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { errorMessage } from '../../../shared/bridge/result'
import { AppearancePreviewSample } from './AppearancePreviewSample'
import { TerminalAppearancePreview } from './TerminalAppearancePreview'

type DraftDefinition = ThemeDefinition & Record<string, unknown>

function serializeDraft(definition: DraftDefinition): string {
  const readable = JSON.stringify(definition, null, 2)
  return new TextEncoder().encode(readable).byteLength <= 256 * 1024 ? readable : JSON.stringify(definition)
}

function parse(source: string): DraftDefinition | null {
  try {
    const value: unknown = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as DraftDefinition
  } catch {
    return null
  }
}

export function ThemeEditorDialog({
  source,
  open,
  onOpenChange,
  onSave,
  focusRole,
  renderDraftDiagnostics,
}: {
  source: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (source: string) => void
  focusRole?: { section: 'app' | 'terminal' | 'syntax'; role: string } | null
  renderDraftDiagnostics?: (
    definition: ThemeDefinition,
    preview: ThemeDraftPreview,
    updateDraft: (source: string) => void,
  ) => ReactNode
}) {
  const [draft, setDraft] = useState(source)
  const [previousInputs, setPreviousInputs] = useState({ source, open })
  if (source !== previousInputs.source || open !== previousInputs.open) {
    setPreviousInputs({ source, open })
    setDraft(source)
  }
  const update = (change: (value: DraftDefinition) => void) => {
    const next = parse(draft)
    if (!next) return
    change(next)
    setDraft(serializeDraft(next))
  }
  const focusInput = useRef<HTMLInputElement>(null)
  const definition = useMemo(() => parse(draft), [draft])
  const preview = useQuery({
    queryKey: ['theme-draft-preview', draft],
    queryFn: () => window.adeHost.themes.previewDraft({ source: draft }),
    enabled: open && Boolean(definition),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  useEffect(() => {
    if (!open || !focusRole || !focusInput.current) return
    const input = focusInput.current
    input.scrollIntoView({ block: 'center' })
    const frame = requestAnimationFrame(() => input.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, focusRole])

  const invalid = !definition
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={focusRole ? focusInput : undefined}
        className="flex h-(--editor-height) flex-col sm:max-w-4xl [--editor-height:85dvh]"
      >
        <DialogHeader>
          <DialogTitle>Edit theme draft</DialogTitle>
          <DialogDescription>
            Changes stay in this editor until you save. Preview resolves the unsaved definition and never applies it to
            profile appearance or running terminals.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <FieldGroup>
            {definition && (
              <>
                <FieldGroup className="grid grid-cols-1 sm:grid-cols-3">
                  <Field>
                    <FieldLabel htmlFor="theme-draft-id">Definition ID</FieldLabel>
                    <Input
                      id="theme-draft-id"
                      value={definition.id}
                      onChange={(event) =>
                        update((value) => {
                          value.id = event.target.value
                        })
                      }
                    />
                    <FieldDescription>Use a distinct user: ID to save a copy.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="theme-draft-name">Name</FieldLabel>
                    <Input
                      id="theme-draft-name"
                      value={definition.name}
                      onChange={(event) =>
                        update((value) => {
                          value.name = event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="theme-draft-mode">Mode</FieldLabel>
                    <NativeSelect
                      id="theme-draft-mode"
                      value={definition.mode}
                      onChange={(event) =>
                        update((value) => {
                          value.mode = event.target.value as PaletteMode
                        })
                      }
                    >
                      <NativeSelectOption value="light">Light</NativeSelectOption>
                      <NativeSelectOption value="dark">Dark</NativeSelectOption>
                    </NativeSelect>
                  </Field>
                </FieldGroup>
                {(['app', 'terminal', 'syntax'] as const).map((section) => {
                  const colors = definition[section]?.tokens ?? {}
                  if (!definition[section]) return null
                  return (
                    <FieldSet key={section}>
                      <FieldLegend>
                        {section === 'app'
                          ? 'App colors'
                          : section === 'terminal'
                            ? 'Terminal colors'
                            : 'Syntax colors'}
                      </FieldLegend>
                      <FieldDescription>
                        Only declared {section} values are shown. Editing a value does not infer or copy visible colors.
                      </FieldDescription>
                      <FieldGroup className="grid grid-cols-1 sm:grid-cols-2">
                        {Object.entries(colors).map(([role, color]) => (
                          <Field key={`${section}-${role}`}>
                            <FieldLabel htmlFor={`theme-role-${section}-${role}`}>{role}</FieldLabel>
                            <Input
                              id={`theme-role-${section}-${role}`}
                              ref={focusRole?.section === section && focusRole.role === role ? focusInput : undefined}
                              value={color}
                              onChange={(event) =>
                                update((value) => {
                                  value[section]!.tokens[role] = event.target.value
                                })
                              }
                            />
                          </Field>
                        ))}
                      </FieldGroup>
                    </FieldSet>
                  )
                })}
                {preview.error && (
                  <FieldError role="alert">
                    Preview failed: {errorMessage(preview.error)} The draft remains available to edit.
                  </FieldError>
                )}
                {preview.data && (
                  <FieldSet>
                    <FieldLegend>Resolved declared section colors</FieldLegend>
                    {(['app', 'syntax'] as const).map((section) => {
                      const palette = preview.data![section]
                      if (!palette) return null
                      return (
                        <Field key={section}>
                          <FieldLabel>
                            {section === 'app' ? 'App' : 'Syntax'} — {palette.name}
                          </FieldLabel>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {Object.entries(palette.tokens).map(([role, value]) => (
                              <div
                                key={`${section}-preview-${role}`}
                                className="flex min-w-0 items-center gap-2 rounded-md bg-card p-2"
                              >
                                <span
                                  aria-hidden="true"
                                  className="size-5 shrink-0 rounded-sm"
                                  style={{ backgroundColor: String(value) }}
                                />
                                <Caption truncate>
                                  {role}: {String(value)}
                                </Caption>
                              </div>
                            ))}
                          </div>
                        </Field>
                      )
                    })}
                    {preview.data!.valid && (
                      <>
                        <FieldDescription>
                          Both mode samples are local only. Omitted sections and the other mode use their matching core
                          defaults; saving preserves only declared values.
                        </FieldDescription>
                        <div className="grid gap-4 md:grid-cols-2">
                          {[preview.data!.light, preview.data!.dark].map((sample) => (
                            <div key={sample.app.mode}>
                              <AppearancePreviewSample {...sample} />
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                    {preview.data!.terminal && !(preview.data!.app && preview.data!.syntax) && (
                      <FieldSet>
                        <FieldLegend>Resolved terminal sample</FieldLegend>
                        <TerminalAppearancePreview appearance={preview.data!.terminal} />
                      </FieldSet>
                    )}
                  </FieldSet>
                )}
                {preview.data && definition && renderDraftDiagnostics?.(definition, preview.data, setDraft)}
              </>
            )}
            <Field>
              <FieldLabel htmlFor="theme-draft-json">Theme definition</FieldLabel>
              <Textarea
                id="theme-draft-json"
                value={draft}
                rows={8}
                spellCheck={false}
                onChange={(event) => setDraft(event.target.value)}
              />
            </Field>
            {invalid && (
              <FieldError role="alert">This draft is not valid JSON. Correct the source or reset the draft.</FieldError>
            )}
          </FieldGroup>
        </ScrollArea>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setDraft(source)}>
            Reset draft
          </Button>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={invalid || preview.isPending || Boolean(preview.error)}
            onClick={() => onSave(draft)}
          >
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
