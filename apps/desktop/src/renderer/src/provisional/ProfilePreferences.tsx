import { useRef, useState } from 'react'
import type { ProfileSettings } from '@ade/contracts'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { AccessibilityPreferences } from './AccessibilityPreferences'

export type ProfilePreferenceKey =
  | 'ui_font_family'
  | 'ui_font_size'
  | 'code_font_family'
  | 'code_font_size'
  | 'terminal_font_family'
  | 'terminal_font_size'
  | 'density'
  | 'terminal_line_height'
  | 'terminal_font_kerning'
  | 'terminal_cursor_shape'
  | 'terminal_cursor_blink'
  | 'reduced_motion'
  | 'high_contrast'
  | 'reduced_transparency'
  | 'differentiate_without_color'
export type ProfilePreferenceValue = string | number | boolean
export type SaveProfilePreference = (field: ProfilePreferenceKey, value: ProfilePreferenceValue) => Promise<void>

const FAMILY_DELIMITERS: Record<string, true> = {
  "'": true,
  '"': true,
  ',': true,
  ';': true,
  ':': true,
  '{': true,
  '}': true,
  '(': true,
  ')': true,
  '[': true,
  ']': true,
  '<': true,
  '>': true,
  '\\': true,
  '/': true,
  '*': true,
}
const fieldId = (label: string): string => `settings-${label.toLowerCase().replaceAll(/\s+/gu, '-')}`

function fontFamilyError(value: string): string | undefined {
  if (!value.trim()) return 'Enter a font family.'
  if ([...value].length > 128) return 'Font family must be 128 characters or fewer.'
  if (
    [...value].some(
      (character) => Object.hasOwn(FAMILY_DELIMITERS, character) || /[\u0000-\u001f\u007f-\u009f]/u.test(character),
    )
  )
    return 'Font family cannot contain control characters or CSS delimiters.'
}

function FamilyPreference({
  label,
  value,
  disabled,
  onSave,
}: {
  label: string
  value: string
  disabled: boolean
  onSave: (value: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string>()
  const invalid = fontFamilyError(draft)
  return (
    <Field data-invalid={Boolean(error || invalid)}>
      <FieldLabel htmlFor={fieldId(label)}>{label}</FieldLabel>
      <Input
        id={fieldId(label)}
        value={draft}
        disabled={disabled}
        aria-invalid={Boolean(error || invalid)}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(undefined)
        }}
      />
      <FieldDescription>Enter an installed font family. Unavailable fonts use a readable fallback.</FieldDescription>
      {invalid && <FieldError>{invalid}</FieldError>}
      {error && <FieldError>{error}</FieldError>}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || Boolean(invalid)}
        onClick={() =>
          void onSave(draft).catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : 'Font family could not be saved.'),
          )
        }
      >
        Apply {label.toLowerCase()}
      </Button>
    </Field>
  )
}

function NumberPreference({
  label,
  value,
  min,
  max,
  disabled,
  onSave,
}: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onSave: (value: number) => Promise<void>
}) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string>()
  const number = Number(draft)
  const valid = draft.trim() !== '' && Number.isInteger(number) && number >= min && number <= max
  return (
    <Field data-invalid={Boolean(error || !valid)}>
      <FieldLabel htmlFor={fieldId(label)}>{label}</FieldLabel>
      <Input
        id={fieldId(label)}
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft}
        disabled={disabled}
        aria-invalid={!valid || Boolean(error)}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(undefined)
        }}
      />
      <FieldDescription>
        Choose a value from {min} to {max}.
      </FieldDescription>
      {!valid && (
        <FieldError>
          Enter a whole number from {min} to {max}.
        </FieldError>
      )}
      {error && <FieldError>{error}</FieldError>}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || !valid}
        onClick={() =>
          void onSave(number).catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : 'Setting could not be saved.'),
          )
        }
      >
        Apply {label.toLowerCase()}
      </Button>
    </Field>
  )
}

function DecimalPreference({
  label,
  value,
  min,
  max,
  disabled,
  onSave,
}: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onSave: (value: number) => Promise<void>
}) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string>()
  const number = Number(draft)
  const valid = draft.trim() !== '' && Number.isFinite(number) && number >= min && number <= max
  return (
    <Field data-invalid={Boolean(error || !valid)}>
      <FieldLabel htmlFor={fieldId(label)}>{label}</FieldLabel>
      <Input
        id={fieldId(label)}
        type="number"
        min={min}
        max={max}
        step="0.05"
        value={draft}
        disabled={disabled}
        aria-invalid={!valid || Boolean(error)}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(undefined)
        }}
      />
      <FieldDescription>
        Choose a value from {min} to {max}.
      </FieldDescription>
      {!valid && (
        <FieldError>
          Enter a number from {min} to {max}.
        </FieldError>
      )}
      {error && <FieldError>{error}</FieldError>}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || !valid}
        onClick={() =>
          void onSave(number).catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : 'Setting could not be saved.'),
          )
        }
      >
        Apply {label.toLowerCase()}
      </Button>
    </Field>
  )
}

function PreferenceField({
  label,
  value,
  options,
  disabled,
  onSave,
}: {
  label: string
  value: string
  options: readonly string[]
  disabled: boolean
  onSave: (value: string) => Promise<void>
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<string>()
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={fieldId(label)}>{label}</FieldLabel>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next) {
            setError(undefined)
            void onSave(next)
              .then(() => trigger.current?.focus())
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : 'Setting could not be saved.'),
              )
          }
        }}
      >
        <SelectTrigger ref={trigger} id={fieldId(label)} aria-invalid={Boolean(error)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

export function ProfilePreferences({
  settings,
  disabled,
  error,
  onSave,
}: {
  settings: ProfileSettings
  disabled: boolean
  error?: string
  onSave: SaveProfilePreference
}) {
  return (
    <FieldGroup className="mt-6">
      <div className="flex flex-col ade-content-group">
        <FieldSet>
          <FieldLegend>Typography</FieldLegend>
          <div className="flex flex-col ade-content-group">
            <FamilyPreference
              key={settings.ui_font_family}
              label="UI font family"
              value={settings.ui_font_family}
              disabled={disabled}
              onSave={(value) => onSave('ui_font_family', value)}
            />
            <NumberPreference
              key={settings.ui_font_size}
              label="UI font size"
              value={settings.ui_font_size}
              min={12}
              max={24}
              disabled={disabled}
              onSave={(value) => onSave('ui_font_size', value)}
            />
            <FamilyPreference
              key={settings.code_font_family}
              label="Code font family"
              value={settings.code_font_family}
              disabled={disabled}
              onSave={(value) => onSave('code_font_family', value)}
            />
            <NumberPreference
              key={settings.code_font_size}
              label="Code font size"
              value={settings.code_font_size}
              min={10}
              max={32}
              disabled={disabled}
              onSave={(value) => onSave('code_font_size', value)}
            />
          </div>
        </FieldSet>
        <FieldSet>
          <FieldLegend>Density</FieldLegend>
          <PreferenceField
            label="Density"
            value={settings.density}
            options={['default', 'compact']}
            disabled={disabled}
            onSave={(value) => onSave('density', value)}
          />
        </FieldSet>
        <AccessibilityPreferences settings={settings} disabled={disabled} onSave={onSave} />
        <FieldSet>
          <FieldLegend>Terminal text</FieldLegend>
          <div className="flex flex-col ade-content-group">
            <FamilyPreference
              key={settings.terminal_font_family}
              label="Terminal font family"
              value={settings.terminal_font_family}
              disabled={disabled}
              onSave={(value) => onSave('terminal_font_family', value)}
            />
            <NumberPreference
              key={settings.terminal_font_size}
              label="Terminal font size"
              value={settings.terminal_font_size}
              min={6}
              max={32}
              disabled={disabled}
              onSave={(value) => onSave('terminal_font_size', value)}
            />
            <DecimalPreference
              key={settings.terminal_line_height}
              label="Terminal line height"
              value={settings.terminal_line_height}
              min={1}
              max={2}
              disabled={disabled}
              onSave={(value) => onSave('terminal_line_height', value)}
            />
            <PreferenceField
              key={settings.terminal_font_kerning}
              label="Terminal font kerning"
              value={settings.terminal_font_kerning}
              options={['auto', 'normal', 'none']}
              disabled={disabled}
              onSave={(value) => onSave('terminal_font_kerning', value)}
            />
            <PreferenceField
              key={settings.terminal_cursor_shape}
              label="Terminal cursor shape"
              value={settings.terminal_cursor_shape}
              options={['block', 'bar', 'underline']}
              disabled={disabled}
              onSave={(value) => onSave('terminal_cursor_shape', value)}
            />
            <Field orientation="horizontal">
              <FieldLabel htmlFor="terminal-cursor-blink">Terminal cursor blink</FieldLabel>
              <Switch
                id="terminal-cursor-blink"
                checked={settings.terminal_cursor_blink}
                disabled={disabled}
                onCheckedChange={(value) => void onSave('terminal_cursor_blink', value).catch(() => {})}
              />
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </div>
        </FieldSet>
      </div>
    </FieldGroup>
  )
}
