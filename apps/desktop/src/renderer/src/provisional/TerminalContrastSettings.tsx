import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export function TerminalContrastSettings({
  saved,
  disabled,
  onSave,
}: {
  saved: number
  disabled: boolean
  onSave: (ratio: number) => void
}) {
  const [draft, setDraft] = useState(String(saved))
  const ratio = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(ratio) && ratio >= 1 && ratio <= 21
  return (
    <Field data-invalid={!valid}>
      <FieldLabel htmlFor="terminal-minimum-contrast">Terminal minimum contrast</FieldLabel>
      <FieldDescription>
        1 keeps exact theme and program colors. Higher ratios adjust rendered text only; saved colors and terminal
        color-query replies stay unchanged. If the background prevents the requested ratio, ADE uses the strongest
        available text contrast.
      </FieldDescription>
      <Input
        id="terminal-minimum-contrast"
        type="number"
        min={1}
        max={21}
        step="any"
        value={draft}
        disabled={disabled}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button variant="outline" size="sm" disabled={disabled || !valid} onClick={() => onSave(ratio)}>
        Apply terminal contrast
      </Button>
    </Field>
  )
}
