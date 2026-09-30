import { useState } from 'react'
import type { BoldColor } from '@ade/contracts'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

export function TerminalBoldSettings({
  saved,
  disabled,
  onSave,
}: {
  saved: BoldColor
  disabled: boolean
  onSave: (policy: BoldColor) => void
}) {
  const [draft, setDraft] = useState(saved)
  const mode = typeof draft === 'string' ? draft : 'custom'
  const hex =
    typeof draft === 'string'
      ? '#ffffff'
      : `#${[draft.r, draft.g, draft.b].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  return (
    <Field>
      <FieldLabel htmlFor="terminal-bold-color">Terminal bold colors</FieldLabel>
      <FieldDescription>
        Bright mode uses palette entries 8–15 for bold text using entries 0–7; truecolor stays unchanged. A custom color
        replaces all bold text colors. Reverse video and dimming apply next, followed by selection colors and contrast
        correction. Saved palettes and terminal color-query replies stay unchanged.
      </FieldDescription>
      <NativeSelect
        id="terminal-bold-color"
        value={mode}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value
          setDraft(value === 'inherit' || value === 'bright' ? value : { r: 255, g: 255, b: 255 })
        }}
      >
        <NativeSelectOption value="inherit">Keep source colors</NativeSelectOption>
        <NativeSelectOption value="bright">Use bright palette</NativeSelectOption>
        <NativeSelectOption value="custom">Custom color</NativeSelectOption>
      </NativeSelect>
      {mode === 'custom' && (
        <Input
          type="color"
          aria-label="Bold text color"
          value={hex}
          disabled={disabled}
          onChange={(event) => {
            const rgb = Number.parseInt(event.target.value.slice(1), 16)
            setDraft({ r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255 })
          }}
        />
      )}
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => onSave(draft)}>
        Apply bold colors
      </Button>
    </Field>
  )
}
