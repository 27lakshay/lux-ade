import { errorMessage } from '../../../shared/bridge/result'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ThemePackIdentity, ThemeValidationResponse } from '@ade/contracts'
import type { ThemeSourceFile } from '../../../shared/bridge/themes'
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
import { ScrollArea } from '@/components/ui/scroll-area'

type Candidate = {
  file: ThemeSourceFile
  validation: ThemeValidationResponse | null
  error: string | null
  pack?: ThemePackIdentity
}

export function ThemeImportDialog() {
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [accepted, setAccepted] = useState<number[]>([])
  const [reviewedRetained, setReviewedRetained] = useState(false)
  const preview = useMutation({
    mutationFn: async (retained?: Candidate[]): Promise<Candidate[]> => {
      const files = retained?.map((candidate) => candidate.file) ?? (await window.adeHost.themes.chooseFiles())
      const candidates: Candidate[] = []
      for (const file of files) {
        try {
          if (file.source === null) candidates.push({ file, validation: null, error: file.error })
          else {
            const report = await window.adeHost.themes.validateFile(file.source)
            if (!report.container_valid)
              candidates.push({
                file,
                validation: null,
                error: report.diagnostics
                  .map(
                    (diagnostic) =>
                      `${diagnostic.path || 'Document'}, line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`,
                  )
                  .join(' '),
              })
            else
              for (const member of report.candidates)
                candidates.push({
                  file: { ...file, source: member.source },
                  validation: member.validation,
                  error: file.error,
                  pack: report.pack ?? member.validation.definition?.pack ?? undefined,
                })
          }
        } catch (error) {
          candidates.push({ file, validation: null, error: errorMessage(error) })
        }
      }
      return candidates
    },
  })
  const installation = useMutation({
    mutationFn: (items: { source: string; expected_revision: number }[]) => window.adeHost.themes.install(items),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['theme-library'] })
      void cache.invalidateQueries({ queryKey: ['theme-record'] })
    },
  })
  const selected = accepted
    .map((index) => preview.data?.[index])
    .filter((candidate): candidate is Candidate => Boolean(candidate))
  const duplicate = new Set(selected.map((candidate) => candidate.validation?.definition?.id)).size !== selected.length
  const exceedsBatch =
    selected.length > 16 ||
    selected.reduce((bytes, candidate) => bytes + new TextEncoder().encode(candidate.file.source ?? '').byteLength, 0) >
      512 * 1024
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!installation.isPending) setOpen(next)
      }}
    >
      <DialogTrigger
        render={<Button size="sm" variant="outline" />}
        onClick={() => {
          setAccepted([])
          setReviewedRetained(false)
          installation.reset()
          preview.mutate()
        }}
      >
        Import theme files
      </DialogTrigger>
      <DialogContent className="flex h-(--import-height) flex-col sm:max-w-4xl [--import-height:85dvh]">
        <DialogHeader>
          <DialogTitle>Import theme files</DialogTitle>
          <DialogDescription>
            Review each source and explicitly accept the valid definitions to install. Replacing an active definition
            updates its colors.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <FieldGroup>
            {reviewedRetained && <Body>Diagnostics now refer to the retained definition data.</Body>}
            {preview.isPending && <Body>Reading selected theme files…</Body>}
            {preview.error && <FieldError>{preview.error.message}</FieldError>}
            {preview.data?.length === 0 && <Body>No theme files selected.</Body>}
            {preview.data?.map((candidate, index) => {
              const protectedTarget =
                candidate.validation?.target?.bundled ||
                /^(ade|plugin(?:\.[^:]+)?):/.test(candidate.validation?.definition?.id ?? '') ||
                ['bundled', 'plugin'].includes(candidate.validation?.definition?.provenance.kind ?? '')
              return (
                <Field key={`${candidate.file.path}:${index}`}>
                  <Body selectable>{candidate.file.path}</Body>
                  {candidate.pack && (
                    <Body>
                      Pack: {candidate.pack.name} — {candidate.pack.id}
                    </Body>
                  )}
                  {candidate.validation?.definition && (
                    <Body>
                      {candidate.validation.definition.name} — {candidate.validation.definition.id},{' '}
                      {candidate.validation.definition.mode}
                    </Body>
                  )}
                  {candidate.error && <FieldError>{candidate.error}</FieldError>}
                  {candidate.validation?.target && (
                    <Body>
                      Existing revision {candidate.validation.target.revision}. Accepting this file replaces that stable
                      ID.
                    </Body>
                  )}
                  {protectedTarget && (
                    <FieldError>This ID is protected. Create a custom draft with a distinct ID.</FieldError>
                  )}
                  <ul>
                    {candidate.validation?.diagnostics.map((diagnostic, diagnosticIndex) => (
                      <li key={diagnosticIndex}>
                        {diagnostic.severity}: {diagnostic.path || 'Document'}, line {diagnostic.line}, column{' '}
                        {diagnostic.column}: {diagnostic.message}
                      </li>
                    ))}
                  </ul>
                  <FieldLabel htmlFor={`accept-theme-${index}`}>
                    <Checkbox
                      id={`accept-theme-${index}`}
                      checked={accepted.includes(index)}
                      disabled={
                        preview.isPending ||
                        !candidate.validation?.valid ||
                        protectedTarget ||
                        installation.isPending ||
                        installation.data?.committed
                      }
                      onCheckedChange={(checked) =>
                        setAccepted((current) =>
                          checked ? [...current, index] : current.filter((item) => item !== index),
                        )
                      }
                    />
                    Accept {candidate.validation?.definition?.id ?? candidate.file.path}
                  </FieldLabel>
                </Field>
              )
            })}
          </FieldGroup>
        </ScrollArea>
        {duplicate && <FieldError>Selected files repeat a theme ID. Accept one definition per ID.</FieldError>}
        {exceedsBatch && (
          <FieldError>Accept at most 16 definitions and 512 KiB of definition data per installation.</FieldError>
        )}
        {installation.error && (
          <FieldError>{installation.error.message} Review retained definitions before retrying.</FieldError>
        )}
        {installation.data && (
          <Body role="status">
            {installation.data.committed
              ? `Installed ${installation.data.items.length} ${installation.data.items.length === 1 ? 'theme' : 'themes'} at library revision ${installation.data.revision}.`
              : 'The accepted set has errors. Nothing was installed.'}
          </Body>
        )}
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            disabled={!preview.data?.length || preview.isPending || installation.isPending}
            onClick={() => {
              setAccepted([])
              setReviewedRetained(true)
              installation.reset()
              preview.mutate(preview.data)
            }}
          >
            Review retained definitions
          </Button>
          <DialogClose render={<Button size="sm" variant="outline" disabled={installation.isPending} />}>
            Close import
          </DialogClose>
          <Button
            size="sm"
            disabled={
              !selected.length ||
              preview.isPending ||
              duplicate ||
              exceedsBatch ||
              installation.isPending ||
              installation.data?.committed
            }
            onClick={() =>
              installation.mutate(
                selected.map((candidate) => ({
                  source: candidate.file.source!,
                  expected_revision: candidate.validation?.target?.revision ?? 0,
                })),
              )
            }
          >
            Install selected themes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
