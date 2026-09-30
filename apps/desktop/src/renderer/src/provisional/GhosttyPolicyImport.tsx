import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BoldColor, GhosttyAppearancePolicies, TerminalAppearance } from '@ade/contracts'
import { errorMessage } from '../../../shared/bridge/result'
import { Body } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { TerminalAppearancePreview } from './TerminalAppearancePreview'

function boldName(value: BoldColor) {
  if (value === 'inherit') return 'Keep source colors'
  if (value === 'bright') return 'Use bright palette'
  return `#${[value.r, value.g, value.b].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Optional settings use the ordinary profile revision fence and a separate local sample. */
export function GhosttyPolicyImport({
  policies,
  appearance,
  disabled,
  onPending,
}: {
  policies: GhosttyAppearancePolicies
  appearance: TerminalAppearance | null
  disabled: boolean
  onPending: (pending: boolean) => void
}) {
  const cache = useQueryClient()
  const [contrastAccepted, setContrastAccepted] = useState(false)
  const [boldAccepted, setBoldAccepted] = useState(false)
  const review = useMutation({
    mutationFn: async () => {
      const settings = await window.adeHost.settings.get()
      const preview = await window.adeHost.themes.preview({
        app_light_theme: settings.app_light_theme,
        app_dark_theme: settings.app_dark_theme,
        terminal_binding: settings.terminal_binding,
        syntax_binding: settings.syntax_binding,
      })
      if (settings.appearance_revision !== preview.appearance_revision)
        throw new Error('Appearance changed during review. Review optional settings again.')
      return { settings, preview }
    },
    onMutate: () => onPending(true),
    onSettled: () => onPending(false),
  })
  const apply = useMutation({
    mutationFn: () =>
      window.adeHost.settings.set({
        expected_appearance_revision: review.data!.settings.appearance_revision,
        expected_theme_revisions: review.data!.preview.expected_theme_revisions,
        ...(contrastAccepted ? { terminal_minimum_contrast: policies.minimum_contrast! } : {}),
        ...(boldAccepted ? { terminal_bold_color: policies.bold_color! } : {}),
      }),
    onMutate: () => onPending(true),
    onSuccess: (saved) => {
      cache.setQueryData(['profile-settings'], saved)
      void cache.invalidateQueries({ queryKey: ['appearance'] })
      void cache.invalidateQueries({ queryKey: ['appearance-startup-status'] })
    },
    onError: () => {
      setContrastAccepted(false)
      setBoldAccepted(false)
      review.reset()
    },
    onSettled: () => onPending(false),
  })
  const selected = contrastAccepted || boldAccepted
  const pending = disabled || review.isPending || apply.isPending
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Optional terminal settings</FieldLabel>
        <FieldDescription>
          These settings affect every terminal in this profile. Installing colors leaves them unchanged. Review the
          current settings, select each change and inspect its temporary preview before applying it separately.
        </FieldDescription>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setContrastAccepted(false)
            setBoldAccepted(false)
            apply.reset()
            review.mutate()
          }}
        >
          Review optional settings
        </Button>
        {review.error && <FieldError>{errorMessage(review.error)}</FieldError>}
        {apply.error && (
          <FieldError>{errorMessage(apply.error)} Review optional settings again before retrying.</FieldError>
        )}
        {review.data && (
          <Body>
            Current minimum contrast: {review.data.settings.terminal_minimum_contrast}. Current bold colors:{' '}
            {boldName(review.data.settings.terminal_bold_color)}.
          </Body>
        )}
      </Field>
      {review.data && policies.minimum_contrast !== null && (
        <Field>
          <FieldLabel htmlFor="import-ghostty-contrast">
            <Checkbox
              id="import-ghostty-contrast"
              checked={contrastAccepted}
              disabled={pending || apply.isSuccess}
              onCheckedChange={(checked) => setContrastAccepted(Boolean(checked))}
            />
            Import minimum contrast: {policies.minimum_contrast}
          </FieldLabel>
          <FieldDescription>
            1 keeps source colors. Higher ratios adjust rendered text; saved colors and terminal query replies remain
            unchanged.
          </FieldDescription>
        </Field>
      )}
      {review.data && policies.bold_color !== null && (
        <Field>
          <FieldLabel htmlFor="import-ghostty-bold">
            <Checkbox
              id="import-ghostty-bold"
              checked={boldAccepted}
              disabled={pending || apply.isSuccess}
              onCheckedChange={(checked) => setBoldAccepted(Boolean(checked))}
            />
            Import bold colors: {boldName(policies.bold_color)}
          </FieldLabel>
          <FieldDescription>
            Bright changes bold palette entries 0–7 to entries 8–15; a custom color changes all bold text. Source colors
            and terminal query replies remain unchanged.
          </FieldDescription>
        </Field>
      )}
      {review.data && selected && (
        <section aria-label="Optional settings preview">
          {appearance && (
            <>
              <Body>Imported colors with optional settings</Body>
              <TerminalAppearancePreview
                appearance={{
                  ...appearance,
                  minimum_contrast: contrastAccepted
                    ? policies.minimum_contrast!
                    : review.data.settings.terminal_minimum_contrast,
                  bold_color: boldAccepted ? policies.bold_color! : review.data.settings.terminal_bold_color,
                }}
              />
            </>
          )}
          {review.data.preview.samples.map((sample) => (
            <div key={sample.app.mode}>
              <Body>
                Current {sample.app.mode} terminal colors: {sample.terminal_name}
              </Body>
              <TerminalAppearancePreview
                appearance={{
                  ...sample.terminal,
                  minimum_contrast: contrastAccepted ? policies.minimum_contrast! : sample.terminal.minimum_contrast,
                  bold_color: boldAccepted ? policies.bold_color! : sample.terminal.bold_color,
                }}
              />
              {sample.diagnostics.map((diagnostic) => (
                <Body key={diagnostic.slot}>{diagnostic.message}</Body>
              ))}
            </div>
          ))}
        </section>
      )}
      <Button
        size="sm"
        disabled={pending || !review.data || !selected || apply.isSuccess}
        onClick={() => apply.mutate()}
      >
        Apply optional terminal settings
      </Button>
      {apply.isSuccess && <Body role="status">Optional terminal settings applied.</Body>}
    </FieldGroup>
  )
}
