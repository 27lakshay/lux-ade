import { useState } from 'react'
import type { TerminalColor, TerminalColorOverrides } from '@ade/contracts'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const roles = [
  ['cursor_text', 'Cursor text'],
  ['selection_foreground', 'Selection foreground'],
  ['selection_background', 'Selection background'],
] as const

export function TerminalColorSettings({
  saved,
  disabled,
  onSave,
}: {
  saved: TerminalColorOverrides
  disabled: boolean
  onSave: (colors: TerminalColorOverrides) => void
}) {
  const [draft, setDraft] = useState(saved)
  const update = (role: (typeof roles)[number][0], value: TerminalColor | undefined) => {
    setDraft((previous) => {
      const next = { ...previous }
      if (value === undefined) delete next[role]
      else next[role] = value
      return next
    })
  }
  return (
    <>
      <FieldDescription>
        Override cursor and selection colors for every terminal in this profile. Theme values restore each selected
        theme’s colors.
      </FieldDescription>
      {roles.map(([role, label]) => {
        const value = draft[role]
        const mode = value == null ? 'theme' : typeof value === 'string' ? value : 'literal'
        const hex =
          typeof value === 'object' && value !== null
            ? `#${[value.r, value.g, value.b].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
            : '#ffffff'
        return (
          <Field key={role}>
            <FieldLabel htmlFor={`terminal-color-${role}`}>{label}</FieldLabel>
            <NativeSelect
              id={`terminal-color-${role}`}
              value={mode}
              disabled={disabled}
              onChange={(event) => {
                const selected = event.target.value
                if (selected === 'theme') update(role, undefined)
                else if (selected === 'cell-foreground' || selected === 'cell-background') update(role, selected)
                else update(role, { r: 255, g: 255, b: 255 })
              }}
            >
              <NativeSelectOption value="theme">Theme value</NativeSelectOption>
              <NativeSelectOption value="cell-foreground">Cell foreground</NativeSelectOption>
              <NativeSelectOption value="cell-background">Cell background</NativeSelectOption>
              <NativeSelectOption value="literal">Custom color</NativeSelectOption>
            </NativeSelect>
            {mode === 'literal' && (
              <Input
                type="color"
                aria-label={`${label} color`}
                disabled={disabled}
                value={hex}
                onChange={(event) => {
                  const rgb = Number.parseInt(event.target.value.slice(1), 16)
                  update(role, { r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255 })
                }}
              />
            )}
          </Field>
        )
      })}
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => onSave(draft)}>
        Apply terminal colors
      </Button>
    </>
  )
}
