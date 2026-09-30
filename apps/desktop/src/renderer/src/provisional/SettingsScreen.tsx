import { WarpThemeImportDialog } from './WarpThemeImportDialog'
import { GhosttyThemeImportDialog } from './GhosttyThemeImportDialog'
import { ThemeImportDialog } from './ThemeImportDialog'
import { useState } from 'react'
import { ThemeLibraryDialog } from './ThemeLibraryDialog'
import { ThemeValidationPanel } from './ThemeValidationPanel'
import { AppearancePreview } from './AppearancePreview'
import { Button } from '@/components/ui/button'
import { SyntaxAppearanceSettings } from './SyntaxAppearanceSettings'
import { FullScreen } from './FullScreen'
import { TerminalBoldSettings } from './TerminalBoldSettings'
import { TerminalContrastSettings } from './TerminalContrastSettings'
import { TerminalColorSettings } from './TerminalColorSettings'
import { TerminalAppearanceSettings } from './TerminalAppearanceSettings'
import { ProfilePreferences, type ProfilePreferenceKey, type ProfilePreferenceValue } from './ProfilePreferences'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Appearance, ThemeBinding, TerminalColorOverrides, BoldColor } from '@ade/contracts'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { applyThemePreference } from '../app/theme'
type SettingsUpdate = Parameters<typeof window.adeHost.settings.set>[0]

// Provisional stock-kit composition until the settings surface has an approved Pen design.
export function SettingsScreen() {
  const cache = useQueryClient()
  const [themeDraft, setThemeDraft] = useState({ source: '', generation: 0 })
  const [preferencePending, setPreferencePending] = useState(false)
  const [preferenceError, setPreferenceError] = useState<string>()
  const savePreference = async (field: ProfilePreferenceKey, value: ProfilePreferenceValue) => {
    setPreferencePending(true)
    setPreferenceError(undefined)
    try {
      const saved = await window.adeHost.settings.set({ [field]: value } as SettingsUpdate)
      cache.setQueryData(['profile-settings'], saved)
      await cache.invalidateQueries({ queryKey: ['profile-settings'] })
    } catch (cause) {
      setPreferenceError(cause instanceof Error ? cause.message : 'Setting could not be saved.')
      throw cause
    } finally {
      setPreferencePending(false)
    }
  }
  const settings = useQuery({ queryKey: ['profile-settings'], queryFn: () => window.adeHost.settings.get() })
  const palettes = useQuery({ queryKey: ['palettes'], queryFn: () => window.adeHost.settings.palettes() })
  const startup = useQuery({
    queryKey: ['appearance-startup-status', settings.data?.appearance_revision],
    queryFn: () => window.adeHost.settings.startupStatus(),
  })
  const appearance = useQuery({
    queryKey: ['appearance', settings.data?.appearance_revision],
    queryFn: () => window.adeHost.settings.appearance(),
    enabled: Boolean(settings.data),
    refetchInterval: (query) => (query.state.data?.propagation.state === 'pending' ? 1000 : false),
  })
  const change = useMutation({
    mutationFn: (
      selection: (
        | { appearance: Appearance }
        | { app_light_theme: string }
        | { app_dark_theme: string }
        | { terminal_binding: ThemeBinding }
        | { syntax_binding: ThemeBinding }
        | { terminal_color_overrides: TerminalColorOverrides }
        | { terminal_minimum_contrast: number }
        | { terminal_bold_color: BoldColor }
        | { reset: true }
      ) & { expected_appearance_revision: number },
    ) =>
      'reset' in selection
        ? window.adeHost.settings.resetAppearance(selection.expected_appearance_revision)
        : window.adeHost.settings.set(selection),
    onError: () => {
      void cache.invalidateQueries({ queryKey: ['profile-settings'] })
    },
    onSuccess: (saved) => {
      cache.setQueryData(['profile-settings'], saved)
      applyThemePreference(saved.appearance)
      void cache.invalidateQueries({ queryKey: ['appearance'] })
      void cache.invalidateQueries({ queryKey: ['appearance-startup-status'] })
    },
  })
  const error = change.error ?? settings.error ?? appearance.error ?? palettes.error ?? startup.error
  return (
    <FullScreen title="Settings">
      {settings.data && palettes.data && <AppearancePreview saved={settings.data} palettes={palettes.data.palettes} />}
      <ThemeImportDialog />
      <GhosttyThemeImportDialog />
      <WarpThemeImportDialog />
      <ThemeLibraryDialog
        onEdit={(source) => setThemeDraft((previous) => ({ source, generation: previous.generation + 1 }))}
      />
      {settings.data && (
        <ProfilePreferences
          settings={settings.data}
          disabled={preferencePending}
          error={preferenceError}
          onSave={savePreference}
        />
      )}
      <FieldGroup className="mt-6">
        <ThemeValidationPanel key={themeDraft.generation} initialSource={themeDraft.source} />
        <Field data-invalid={Boolean(error)}>
          <FieldLabel id="appearance-label">Appearance</FieldLabel>
          <FieldDescription>Choose the app colors for this profile.</FieldDescription>
          <ToggleGroup
            aria-labelledby="appearance-label"
            value={settings.data ? [settings.data.appearance] : []}
            disabled={settings.isPending || change.isPending}
            variant="outline"
            size="sm"
            onValueChange={(values) => {
              const value = values[0]
              if (settings.data && (value === 'light' || value === 'dark' || value === 'system')) {
                change.mutate({ appearance: value, expected_appearance_revision: settings.data.appearance_revision })
              }
            }}
          >
            <ToggleGroupItem value="system">System</ToggleGroupItem>
            <ToggleGroupItem value="light">
              Light —{' '}
              {palettes.data?.palettes.find((palette) => palette.id === settings.data?.app_light_theme)?.name ??
                appearance.data?.light_palette.name ??
                settings.data?.app_light_theme ??
                'Chalk'}
            </ToggleGroupItem>
            <ToggleGroupItem value="dark">
              Dark —{' '}
              {palettes.data?.palettes.find((palette) => palette.id === settings.data?.app_dark_theme)?.name ??
                appearance.data?.dark_palette.name ??
                settings.data?.app_dark_theme ??
                'Graphite'}
            </ToggleGroupItem>
          </ToggleGroup>
          {startup.data?.warnings.map((warning) => (
            <FieldDescription role="status" key={warning}>
              {warning}
            </FieldDescription>
          ))}
          {appearance.data?.diagnostics.map((diagnostic) => (
            <FieldDescription role="status" key={diagnostic.slot}>
              {diagnostic.message}
            </FieldDescription>
          ))}
          {appearance.data?.terminal_diagnostics.map((diagnostic) => (
            <FieldDescription role="status" key={diagnostic.slot}>
              Terminal: {diagnostic.message}
            </FieldDescription>
          ))}
          {appearance.data?.propagation.state === 'pending' && (
            <FieldDescription role="status">Saved. Terminal colors are still updating.</FieldDescription>
          )}
          {appearance.data?.propagation.state === 'unavailable' && (
            <FieldError>
              Saved. Terminal colors could not be confirmed: {appearance.data.propagation.message}
            </FieldError>
          )}
          {appearance.data && appearance.data.propagation.state !== 'applied' && settings.data && (
            <Button
              variant="outline"
              size="sm"
              disabled={change.isPending}
              onClick={() => {
                if (settings.data)
                  change.mutate({
                    appearance: settings.data.appearance,
                    expected_appearance_revision: settings.data.appearance_revision,
                  })
              }}
            >
              Retry terminal update
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!settings.data || change.isPending}
            onClick={() => {
              if (settings.data)
                change.mutate({ reset: true, expected_appearance_revision: settings.data.appearance_revision })
            }}
          >
            Restore default appearance
          </Button>
          {error && <FieldError>{error.message}</FieldError>}
        </Field>
        {(['light', 'dark'] as const).map((mode) => {
          const slot = mode === 'light' ? 'app_light_theme' : 'app_dark_theme'
          return (
            <Field key={mode}>
              <FieldLabel id={`${mode}-palette-label`}>
                {mode === 'light' ? 'Light palette' : 'Dark palette'}
              </FieldLabel>
              <ToggleGroup
                aria-labelledby={`${mode}-palette-label`}
                value={settings.data ? [settings.data[slot]] : []}
                disabled={!settings.data || palettes.isPending || change.isPending}
                variant="outline"
                size="sm"
                onValueChange={(values) => {
                  const value = values[0]
                  if (settings.data && value)
                    change.mutate({
                      ...(mode === 'light' ? { app_light_theme: value } : { app_dark_theme: value }),
                      expected_appearance_revision: settings.data.appearance_revision,
                    })
                }}
              >
                {palettes.data?.palettes
                  .filter((palette) => palette.mode === mode)
                  .map((palette) => (
                    <ToggleGroupItem key={palette.id} value={palette.id}>
                      {palette.name}
                    </ToggleGroupItem>
                  ))}
              </ToggleGroup>
            </Field>
          )
        })}
        <Field>
          <FieldLabel id="terminal-binding-label">Terminal theme</FieldLabel>
          <FieldDescription>Follow the app, choose a separate light/dark pair, or keep one theme.</FieldDescription>
          <ToggleGroup
            aria-labelledby="terminal-binding-label"
            value={settings.data ? [settings.data.terminal_binding.kind] : []}
            disabled={!settings.data || change.isPending}
            variant="outline"
            size="sm"
            onValueChange={(values) => {
              if (!settings.data) return
              const kind = values[0]
              const binding: ThemeBinding | undefined =
                kind === 'follow_app'
                  ? { kind }
                  : kind === 'fixed'
                    ? { kind, theme_id: settings.data.app_dark_theme }
                    : kind === 'paired'
                      ? { kind, light: settings.data.app_light_theme, dark: settings.data.app_dark_theme }
                      : undefined
              if (binding)
                change.mutate({
                  terminal_binding: binding,
                  expected_appearance_revision: settings.data.appearance_revision,
                })
            }}
          >
            <ToggleGroupItem value="follow_app">Follow app</ToggleGroupItem>
            <ToggleGroupItem value="paired">Separate pair</ToggleGroupItem>
            <ToggleGroupItem value="fixed">Fixed theme</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        {settings.data &&
          settings.data.terminal_binding.kind !== 'follow_app' &&
          (settings.data.terminal_binding.kind === 'fixed' ? (['fixed'] as const) : (['light', 'dark'] as const)).map(
            (slot) => {
              const binding = settings.data!.terminal_binding
              const selected =
                binding.kind === 'fixed'
                  ? binding.theme_id
                  : binding.kind === 'paired'
                    ? binding[slot === 'light' ? 'light' : 'dark']
                    : ''
              return (
                <Field key={`terminal-${slot}`}>
                  <FieldLabel id={`terminal-${slot}-label`}>
                    {slot === 'fixed'
                      ? 'Fixed terminal palette'
                      : slot === 'light'
                        ? 'Light terminal palette'
                        : 'Dark terminal palette'}
                  </FieldLabel>
                  <ToggleGroup
                    aria-labelledby={`terminal-${slot}-label`}
                    value={[selected]}
                    disabled={palettes.isPending || change.isPending}
                    variant="outline"
                    size="sm"
                    onValueChange={(values) => {
                      const theme = values[0]
                      if (!theme || !settings.data || binding.kind === 'follow_app') return
                      const next: ThemeBinding =
                        binding.kind === 'fixed' ? { ...binding, theme_id: theme } : { ...binding, [slot]: theme }
                      change.mutate({
                        terminal_binding: next,
                        expected_appearance_revision: settings.data.appearance_revision,
                      })
                    }}
                  >
                    {palettes.data?.palettes
                      .filter((palette) => slot === 'fixed' || palette.mode === slot)
                      .map((palette) => (
                        <ToggleGroupItem key={palette.id} value={palette.id}>
                          {palette.name}
                        </ToggleGroupItem>
                      ))}
                  </ToggleGroup>
                </Field>
              )
            },
          )}
        {settings.data && palettes.data && (
          <SyntaxAppearanceSettings
            key={JSON.stringify(settings.data.syntax_binding)}
            saved={settings.data.syntax_binding}
            resolved={appearance.data?.syntax}
            palettes={palettes.data.palettes}
            disabled={change.isPending || settings.isFetching}
            onSave={(binding) =>
              change.mutate({
                syntax_binding: binding,
                expected_appearance_revision: settings.data!.appearance_revision,
              })
            }
          />
        )}
        {settings.data && palettes.data && (
          <TerminalAppearanceSettings settings={settings.data} palettes={palettes.data.palettes} />
        )}
        {settings.data && (
          <TerminalColorSettings
            key={JSON.stringify(settings.data.terminal_color_overrides)}
            saved={settings.data.terminal_color_overrides}
            disabled={change.isPending || settings.isFetching}
            onSave={(colors) =>
              change.mutate({
                terminal_color_overrides: colors,
                expected_appearance_revision: settings.data!.appearance_revision,
              })
            }
          />
        )}
        {settings.data && (
          <TerminalContrastSettings
            key={settings.data.terminal_minimum_contrast}
            saved={settings.data.terminal_minimum_contrast}
            disabled={change.isPending || settings.isFetching}
            onSave={(ratio) =>
              change.mutate({
                terminal_minimum_contrast: ratio,
                expected_appearance_revision: settings.data!.appearance_revision,
              })
            }
          />
        )}
        {settings.data && (
          <TerminalBoldSettings
            key={JSON.stringify(settings.data.terminal_bold_color)}
            saved={settings.data.terminal_bold_color}
            disabled={change.isPending || settings.isFetching}
            onSave={(policy) =>
              change.mutate({
                terminal_bold_color: policy,
                expected_appearance_revision: settings.data!.appearance_revision,
              })
            }
          />
        )}
      </FieldGroup>
    </FullScreen>
  )
}
