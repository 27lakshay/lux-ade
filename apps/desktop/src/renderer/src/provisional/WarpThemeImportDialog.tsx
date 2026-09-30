import { TerminalAppearancePreview } from './TerminalAppearancePreview'
import { errorMessage } from '../../../shared/bridge/result'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Body } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

export function WarpThemeImportDialog() {
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [id, setId] = useState('user:warp-theme')
  const [accepted, setAccepted] = useState(false)
  const file = useMutation({ mutationFn: () => window.adeHost.themes.chooseWarpFile() })
  const review = useMutation({
    mutationFn: () =>
      window.adeHost.themes.validateWarp({
        source: file.data?.source ?? '',
        id,
        source_name: file.data?.path ?? null,
      }),
  })
  const installation = useMutation({
    mutationFn: () =>
      window.adeHost.themes.install([
        { source: review.data!.source!, expected_revision: review.data!.validation.target?.revision ?? 0 },
      ]),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['theme-library'] })
      void cache.invalidateQueries({ queryKey: ['theme-record'] })
    },
    onError: () => {
      setAccepted(false)
      review.reset()
    },
  })
  const pending = file.isPending || review.isPending || installation.isPending
  const validation = review.data?.validation
  const protectedTarget =
    validation?.target?.bundled || /^(ade|plugin(?:\.[^:]+)?):/.test(validation?.definition?.id ?? '')
  const validId = /^user:[a-z0-9][a-z0-9._-]*$/.test(id)
  function resetReview() {
    review.reset()
    installation.reset()
    setAccepted(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next)
      }}
    >
      <DialogTrigger
        render={<Button size="sm" variant="outline" />}
        onClick={() => {
          resetReview()
          installation.reset()
          file.reset()
          file.mutate()
        }}
      >
        Import Warp theme
      </DialogTrigger>
      <DialogContent className="flex h-(--import-height) flex-col [--import-height:85dvh]">
        <DialogHeader>
          <DialogTitle>Import Warp theme</DialogTitle>
          <DialogDescription>
            Review supported colors and diagnostics before adding this theme to the library. Unsupported Warp settings
            are not applied. The temporary terminal sample does not change your appearance.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="pr-3">
            <FieldGroup className="min-w-0 wrap-anywhere">
              {file.isPending && <Body>Reading selected Warp YAML…</Body>}
              {file.data && <Body selectable>{file.data.path}</Body>}
              {!file.isPending && !file.data && <Body>No Warp theme file selected.</Body>}
              {file.data?.error && <FieldError>{file.data.error}</FieldError>}
              {file.error && <FieldError>{errorMessage(file.error)}</FieldError>}
              <Field>
                <FieldLabel htmlFor="warp-theme-id">Theme ID</FieldLabel>
                <Input
                  id="warp-theme-id"
                  value={id}
                  disabled={pending}
                  aria-invalid={!validId}
                  onChange={(event) => {
                    setId(event.target.value)
                    resetReview()
                  }}
                />
              </Field>
              {!validId && <FieldError>Use a theme ID beginning with user:.</FieldError>}
              <Button
                size="sm"
                disabled={pending || !validId || !file.data?.source || Boolean(file.data.error)}
                onClick={() => {
                  resetReview()
                  review.mutate()
                }}
              >
                Review Warp theme
              </Button>
              {review.error && <FieldError>{errorMessage(review.error)}</FieldError>}
              {installation.error && (
                <FieldError>
                  {errorMessage(installation.error)} Choose the file and review it again before retrying.
                </FieldError>
              )}
              {validation && (
                <div role="status" aria-live="polite">
                  <Body>{validation.valid ? 'Warp theme is valid.' : 'Warp theme has errors.'}</Body>
                  {validation.definition && (
                    <Body>
                      {validation.definition.name} — {validation.definition.id}, {validation.definition.mode}
                    </Body>
                  )}
                  {validation.target && (
                    <Body>Installing replaces existing revision {validation.target.revision}.</Body>
                  )}
                  {protectedTarget && <FieldError>This ID is protected. Choose a custom theme ID.</FieldError>}
                  <ul>
                    {validation.diagnostics.map((diagnostic, index) => (
                      <li key={index}>
                        {diagnostic.severity}, line {diagnostic.line}, column {diagnostic.column}: {diagnostic.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {review.data?.preview && (
                <Field>
                  <Body>Temporary terminal preview</Body>
                  <TerminalAppearancePreview appearance={review.data.preview} />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="accept-warp-theme">
                  <Checkbox
                    id="accept-warp-theme"
                    checked={accepted}
                    disabled={pending || !validation?.valid || protectedTarget || Boolean(installation.data?.committed)}
                    onCheckedChange={(checked) => setAccepted(Boolean(checked))}
                  />
                  Accept reviewed theme
                </FieldLabel>
              </Field>
              {installation.data?.committed && (
                <Body role="status">Warp theme installed at library revision {installation.data.revision}.</Body>
              )}
            </FieldGroup>
          </div>
        </ScrollArea>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" disabled={pending} />}>Close import</DialogClose>
          <Button
            size="sm"
            disabled={
              pending ||
              !accepted ||
              !review.data?.source ||
              !validation?.valid ||
              protectedTarget ||
              Boolean(installation.data?.committed)
            }
            onClick={() => installation.mutate()}
          >
            Install Warp theme
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
