import { useState } from 'react'
import type { BuiltinPalette, ResolvedSyntaxAppearance, ThemeBinding } from '@ade/contracts'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

export function SyntaxAppearanceSettings({
  saved,
  resolved,
  palettes,
  disabled,
  onSave,
}: {
  saved: ThemeBinding
  resolved?: ResolvedSyntaxAppearance
  palettes: BuiltinPalette[]
  disabled: boolean
  onSave: (binding: ThemeBinding) => void
}) {
  const [draft, setDraft] = useState(saved)
  return (
    <>
      <Field>
        <FieldLabel htmlFor="syntax-binding">Syntax theme mode</FieldLabel>
        <FieldDescription>Choose code colors independently from app and terminal colors.</FieldDescription>
        <NativeSelect
          id="syntax-binding"
          disabled={disabled}
          value={draft.kind}
          onChange={(event) => {
            const kind = event.target.value
            if (kind === 'follow_app') setDraft({ kind })
            else if (kind === 'fixed') setDraft({ kind, theme_id: resolved?.palette.id ?? 'ade:graphite' })
            else if (kind === 'paired') setDraft({ kind, light: 'ade:chalk', dark: 'ade:graphite' })
          }}
        >
          <NativeSelectOption value="follow_app">Follow app</NativeSelectOption>
          <NativeSelectOption value="paired">Separate light and dark themes</NativeSelectOption>
          <NativeSelectOption value="fixed">Fixed theme</NativeSelectOption>
        </NativeSelect>
        {resolved && (
          <FieldDescription role="status">
            Saved syntax theme: {resolved.palette.name} ({resolved.palette.mode}).
          </FieldDescription>
        )}
        {resolved?.diagnostics.map((diagnostic) => (
          <FieldDescription key={diagnostic.slot} role="status">
            Syntax: {diagnostic.message}
          </FieldDescription>
        ))}
      </Field>
      {draft.kind !== 'follow_app' &&
        (draft.kind === 'fixed' ? (['fixed'] as const) : (['light', 'dark'] as const)).map((slot) => (
          <Field key={slot}>
            <FieldLabel htmlFor={`syntax-${slot}`}>
              {slot === 'fixed' ? 'Fixed syntax theme' : `${slot === 'light' ? 'Light' : 'Dark'} syntax theme`}
            </FieldLabel>
            <NativeSelect
              id={`syntax-${slot}`}
              disabled={disabled}
              value={draft.kind === 'fixed' ? draft.theme_id : draft[slot === 'light' ? 'light' : 'dark']}
              onChange={(event) =>
                setDraft(
                  draft.kind === 'fixed'
                    ? { ...draft, theme_id: event.target.value }
                    : { ...draft, [slot]: event.target.value },
                )
              }
            >
              {palettes
                .filter((palette) => slot === 'fixed' || palette.mode === slot)
                .map((palette) => (
                  <NativeSelectOption key={palette.id} value={palette.id}>
                    {palette.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
        ))}
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => onSave(draft)}>
        Apply syntax theme
      </Button>
    </>
  )
}
