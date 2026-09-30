import { errorMessage } from '../../../shared/bridge/result'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { BuiltinPalette, ProfileSettings, ThemeBinding, ThemePreviewRequest } from '@ade/contracts'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { AppearancePreviewSample } from './AppearancePreviewSample'

function PreviewDraft({
  saved,
  palettes,
  onClose,
  selection,
}: {
  saved: ProfileSettings
  palettes: BuiltinPalette[]
  onClose: () => void
  selection?: Omit<ThemePreviewRequest, 'op'>
}) {
  const cache = useQueryClient()
  const [draft, setDraft] = useState<Omit<ThemePreviewRequest, 'op'>>(
    selection ?? {
      app_light_theme: saved.app_light_theme,
      app_dark_theme: saved.app_dark_theme,
      terminal_binding: saved.terminal_binding,
      syntax_binding: saved.syntax_binding,
    },
  )
  const [revision, setRevision] = useState(saved.appearance_revision)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [rebased, setRebased] = useState(false)
  const preview = useQuery({
    queryKey: ['theme-preview', draft],
    queryFn: () => window.adeHost.themes.preview(draft),
    staleTime: Infinity,
    gcTime: 0,
  })
  const apply = async () => {
    setPending(true)
    setError(null)
    try {
      if (!preview.data) throw new Error('Wait for the preview to resolve')
      const result = await window.adeHost.settings.set({
        ...draft,
        expected_appearance_revision: revision,
        expected_theme_revisions: preview.data.expected_theme_revisions,
      })
      cache.setQueryData(['profile-settings'], result)
      void cache.invalidateQueries({ queryKey: ['appearance'] })
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  const rebase = async () => {
    setPending(true)
    try {
      const latest = await window.adeHost.settings.get()
      const refreshed = await preview.refetch()
      if (refreshed.error) throw refreshed.error
      setRevision(latest.appearance_revision)
      setError(null)
      setRebased(true)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  const validation = preview.error?.message ?? (preview.isPending ? 'Resolving preview…' : null)
  const samples = preview.data?.samples ?? []
  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <FieldGroup>
          {(['light', 'dark'] as const).map((mode) => {
            const slot = mode === 'light' ? 'app_light_theme' : 'app_dark_theme'
            return (
              <Field key={mode}>
                <FieldLabel htmlFor={`preview-${mode}`}>
                  {mode === 'light' ? 'Preview light palette' : 'Preview dark palette'}
                </FieldLabel>
                <NativeSelect
                  id={`preview-${mode}`}
                  disabled={pending}
                  value={draft[slot]}
                  onChange={(event) => setDraft({ ...draft, [slot]: event.target.value })}
                >
                  {!palettes.some((palette) => palette.id === draft[slot]) && (
                    <NativeSelectOption value={draft[slot]}>{draft[slot]}</NativeSelectOption>
                  )}
                  {palettes
                    .filter((palette) => palette.mode === mode)
                    .map((palette) => (
                      <NativeSelectOption key={palette.id} value={palette.id}>
                        {palette.name}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Field>
            )
          })}
          {(['terminal', 'syntax'] as const).map((target) => {
            const slot = target === 'terminal' ? 'terminal_binding' : 'syntax_binding'
            const binding = draft[slot]
            const label = target === 'terminal' ? 'Terminal' : 'Syntax'
            const update = (next: ThemeBinding) => setDraft({ ...draft, [slot]: next })
            return (
              <FieldGroup key={target}>
                <Field>
                  <FieldLabel htmlFor={`preview-${target}-mode`}>{label} preview mode</FieldLabel>
                  <NativeSelect
                    id={`preview-${target}-mode`}
                    disabled={pending}
                    value={binding.kind}
                    onChange={(event) => {
                      const kind = event.target.value
                      if (kind === 'follow_app') update({ kind })
                      else if (kind === 'fixed') update({ kind, theme_id: draft.app_dark_theme })
                      else if (kind === 'paired')
                        update({ kind, light: draft.app_light_theme, dark: draft.app_dark_theme })
                    }}
                  >
                    <NativeSelectOption value="follow_app">Follow app</NativeSelectOption>
                    <NativeSelectOption value="fixed">Fixed theme</NativeSelectOption>
                    <NativeSelectOption value="paired">Separate light and dark themes</NativeSelectOption>
                  </NativeSelect>
                </Field>
                {binding.kind !== 'follow_app' &&
                  (binding.kind === 'fixed' ? ['fixed'] : ['light', 'dark']).map((mode) => (
                    <Field key={mode}>
                      <FieldLabel htmlFor={`preview-${target}-${mode}`}>
                        {label} {mode} preview theme
                      </FieldLabel>
                      <NativeSelect
                        id={`preview-${target}-${mode}`}
                        disabled={pending}
                        value={
                          binding.kind === 'fixed' ? binding.theme_id : binding[mode === 'light' ? 'light' : 'dark']
                        }
                        onChange={(event) =>
                          update(
                            binding.kind === 'fixed'
                              ? { ...binding, theme_id: event.target.value }
                              : { ...binding, [mode]: event.target.value },
                          )
                        }
                      >
                        {!palettes.some(
                          (palette) =>
                            palette.id ===
                            (binding.kind === 'fixed'
                              ? binding.theme_id
                              : binding[mode === 'light' ? 'light' : 'dark']),
                        ) && (
                          <NativeSelectOption
                            value={
                              binding.kind === 'fixed' ? binding.theme_id : binding[mode === 'light' ? 'light' : 'dark']
                            }
                          >
                            {binding.kind === 'fixed' ? binding.theme_id : binding[mode === 'light' ? 'light' : 'dark']}
                          </NativeSelectOption>
                        )}
                        {palettes
                          .filter((palette) => mode === 'fixed' || palette.mode === mode)
                          .map((palette) => (
                            <NativeSelectOption key={palette.id} value={palette.id}>
                              {palette.name}
                            </NativeSelectOption>
                          ))}
                      </NativeSelect>
                    </Field>
                  ))}
              </FieldGroup>
            )
          })}
          {rebased && (
            <FieldDescription role="status">
              Draft retained against the latest saved appearance. Review it before applying.
            </FieldDescription>
          )}
          {(error || validation) && <FieldError>{error ?? validation}</FieldError>}
        </FieldGroup>
        <div className="grid gap-4 md:grid-cols-2">
          {samples.map((sample) => (
            <div key={sample.app.mode}>
              {sample.diagnostics.map((diagnostic) => (
                <FieldDescription key={`${diagnostic.selected_id}-${diagnostic.message}`} role="status">
                  {diagnostic.message}
                </FieldDescription>
              ))}
              <AppearancePreviewSample {...sample} />
            </div>
          ))}
        </div>
      </ScrollArea>
      <DialogFooter>
        <Button size="sm" variant="outline" disabled={pending} onClick={onClose}>
          Cancel preview
        </Button>
        {error && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void rebase()}>
            Rebase preview
          </Button>
        )}
        <Button size="sm" disabled={pending || Boolean(validation)} onClick={() => void apply()}>
          Apply preview
        </Button>
      </DialogFooter>
    </>
  )
}

export function AppearancePreview({
  saved,
  palettes,
  selection,
  label = 'Preview appearance',
}: {
  saved: ProfileSettings
  palettes: BuiltinPalette[]
  selection?: Omit<ThemePreviewRequest, 'op'>
  label?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>{label}</DialogTrigger>
      <DialogContent className="flex h-(--preview-height) flex-col sm:max-w-4xl [--preview-height:85dvh]">
        <DialogHeader>
          <DialogTitle>Preview appearance</DialogTitle>
          <DialogDescription>
            Compare both variants locally. Apply saves app, terminal and syntax selections for this profile.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <PreviewDraft saved={saved} palettes={palettes} selection={selection} onClose={() => setOpen(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}
