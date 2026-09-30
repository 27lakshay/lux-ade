import { TerminalAppearancePreview } from './TerminalAppearancePreview'
import { GhosttyPolicyImport } from './GhosttyPolicyImport'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { PaletteMode } from '@ade/contracts'
import { errorMessage } from '../../../shared/bridge/result'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export function GhosttyThemeImportDialog() {
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [id, setId] = useState('user:ghostty-theme')
  const [name, setName] = useState('Ghostty theme')
  const [mode, setMode] = useState<PaletteMode>('dark')
  const [accepted, setAccepted] = useState(false)
  const [policyPending, setPolicyPending] = useState(false)
  const file = useMutation({ mutationFn: () => window.adeHost.themes.chooseGhosttyFile() })
  const review = useMutation({
    mutationFn: () =>
      window.adeHost.themes.validateGhostty({
        source: file.data?.source ?? '',
        id,
        name,
        mode,
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
  const pending = file.isPending || review.isPending || installation.isPending || policyPending
  const report = review.data?.validation
  const protectedTarget = report?.target?.bundled || /^(ade|plugin(?:\.[^:]+)?):/.test(report?.definition?.id ?? '')
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
          file.reset()
          file.mutate()
        }}
      >
        Import Ghostty theme
      </DialogTrigger>
      <DialogContent className="flex h-(--import-height) flex-col [--import-height:85dvh]">
        <DialogHeader>
          <DialogTitle>Import Ghostty theme</DialogTitle>
          <DialogDescription>
            Choose a theme file, review its colors and explicitly accept installation. Choose its light or dark variant.
            Optional terminal settings require their own preview and acceptance. Other configuration is retained as
            data.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="pr-3">
            <FieldGroup className="min-w-0 wrap-anywhere">
              {file.isPending && <Body>Reading selected Ghostty theme…</Body>}
              {file.data && <Body selectable>{file.data.path}</Body>}
              {!file.isPending && !file.data && <Body>No Ghostty theme file selected.</Body>}
              {file.data?.error && <FieldError>{file.data.error}</FieldError>}
              {file.error && <FieldError>{errorMessage(file.error)}</FieldError>}
              <Field>
                <FieldLabel htmlFor="ghostty-theme-id">Ghostty theme ID</FieldLabel>
                <Input
                  id="ghostty-theme-id"
                  value={id}
                  disabled={pending}
                  onChange={(event) => {
                    setId(event.target.value)
                    resetReview()
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="ghostty-theme-name">Ghostty theme name</FieldLabel>
                <Input
                  id="ghostty-theme-name"
                  value={name}
                  disabled={pending}
                  onChange={(event) => {
                    setName(event.target.value)
                    resetReview()
                  }}
                />
              </Field>
              <Field>
                <FieldLabel id="ghostty-theme-mode">Ghostty theme mode</FieldLabel>
                <ToggleGroup
                  aria-labelledby="ghostty-theme-mode"
                  value={[mode]}
                  disabled={pending}
                  onValueChange={(values) => {
                    const next = values[0]
                    if (next === 'light' || next === 'dark') {
                      setMode(next)
                      resetReview()
                    }
                  }}
                >
                  <ToggleGroupItem value="light">Light</ToggleGroupItem>
                  <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <Button
                size="sm"
                disabled={pending || !file.data?.source || Boolean(file.data.error)}
                onClick={() => {
                  resetReview()
                  review.mutate()
                }}
              >
                Review Ghostty colors
              </Button>
              {review.error && <FieldError>{errorMessage(review.error)}</FieldError>}
              {installation.error && (
                <FieldError>
                  {errorMessage(installation.error)} Review the retained file again before retrying.
                </FieldError>
              )}
              {report && (
                <div role="status" aria-live="polite">
                  <Body>{report.valid ? 'Ghostty colors are valid.' : 'Ghostty colors have errors.'}</Body>
                  {report.definition && (
                    <Body>
                      {report.definition.name} — {report.definition.id}, {report.definition.mode}
                    </Body>
                  )}
                  {report.target && <Body>Installing replaces existing revision {report.target.revision}.</Body>}
                  {protectedTarget && <FieldError>This ID is protected. Choose a custom theme ID.</FieldError>}
                  <ul>
                    {report.diagnostics.map((diagnostic, index) => (
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
              {review.data &&
                (review.data.policies.minimum_contrast !== null || review.data.policies.bold_color !== null) && (
                  <GhosttyPolicyImport
                    policies={review.data.policies}
                    appearance={review.data.preview}
                    disabled={pending}
                    onPending={setPolicyPending}
                  />
                )}
              <Field>
                <FieldLabel htmlFor="accept-ghostty-theme">
                  <Checkbox
                    id="accept-ghostty-theme"
                    checked={accepted}
                    disabled={pending || !report?.valid || protectedTarget || Boolean(installation.data?.committed)}
                    onCheckedChange={(checked) => setAccepted(Boolean(checked))}
                  />
                  Accept reviewed colors
                </FieldLabel>
              </Field>
              {installation.data?.committed && (
                <Body role="status">Ghostty theme installed at library revision {installation.data.revision}.</Body>
              )}
            </FieldGroup>
          </div>
        </ScrollArea>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" disabled={pending} />}>Close</DialogClose>
          <Button
            size="sm"
            disabled={
              pending ||
              !accepted ||
              !review.data?.source ||
              !report?.valid ||
              protectedTarget ||
              Boolean(installation.data?.committed)
            }
            onClick={() => installation.mutate()}
          >
            Install Ghostty theme
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
