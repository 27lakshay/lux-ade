import { useState } from 'react'
import type { ProfileSettings } from '@ade/contracts'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const options = ['system', 'on', 'off'] as const
type PreferenceKey = 'reduced_motion' | 'high_contrast' | 'reduced_transparency' | 'differentiate_without_color'
type PreferenceValue = (typeof options)[number]

const preferences: { key: PreferenceKey; label: string }[] = [
  { key: 'reduced_motion', label: 'Reduced motion' },
  { key: 'high_contrast', label: 'High contrast' },
  { key: 'reduced_transparency', label: 'Reduced transparency' },
  { key: 'differentiate_without_color', label: 'Differentiate without color' },
]

function Preference({
  label,
  value,
  disabled,
  onSave,
}: {
  label: string
  value: PreferenceValue
  disabled: boolean
  onSave: (value: PreferenceValue) => Promise<void>
}) {
  const [error, setError] = useState<string>()
  const id = `settings-${label.toLowerCase().replaceAll(/\s+/gu, '-')}`
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (options.includes(next as PreferenceValue)) {
            setError(undefined)
            void onSave(next as PreferenceValue).catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : 'Setting could not be saved.'),
            )
          }
        }}
      >
        <SelectTrigger id={id} aria-invalid={Boolean(error)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option === 'system' ? 'System' : option === 'on' ? 'On' : 'Off'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

export function AccessibilityPreferences({
  settings,
  disabled,
  onSave,
}: {
  settings: Pick<ProfileSettings, PreferenceKey>
  disabled: boolean
  onSave: (key: PreferenceKey, value: PreferenceValue) => Promise<void>
}) {
  return (
    <FieldGroup className="mt-6">
      <FieldSet>
        <FieldLegend>Accessibility</FieldLegend>
        <FieldDescription>
          System follows available operating-system settings. On and Off override them.
        </FieldDescription>
        <div className="flex flex-col ade-content-group">
          {preferences.map(({ key, label }) => (
            <Preference
              key={key}
              label={label}
              value={settings[key]}
              disabled={disabled}
              onSave={(value) => onSave(key, value)}
            />
          ))}
        </div>
      </FieldSet>
    </FieldGroup>
  )
}
