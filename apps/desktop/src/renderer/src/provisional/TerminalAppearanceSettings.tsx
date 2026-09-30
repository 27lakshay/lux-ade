import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BuiltinPalette, ProfileSettings, ThemeBinding } from '@ade/contracts'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useDaemon } from '../state/hooks'

export function TerminalAppearanceSettings({
  settings,
  palettes,
}: {
  settings: ProfileSettings
  palettes: BuiltinPalette[]
}) {
  const terminals = useDaemon((state) => state.terminals)
  const workspaces = useDaemon((state) => state.workspaces)
  const bootId = useDaemon((state) => state.bootId)
  const [selectedId, select] = useState('')
  const selected = terminals[selectedId]
  return (
    <>
      <Field>
        <FieldLabel htmlFor="appearance-terminal">Terminal to customize</FieldLabel>
        <FieldDescription>
          An override belongs to this terminal and stays with it across views and restarts.
        </FieldDescription>
        <NativeSelect
          id="appearance-terminal"
          value={selected?.id ?? ''}
          onChange={(event) => select(event.target.value)}
        >
          <NativeSelectOption value="">Choose a terminal</NativeSelectOption>
          {Object.values(terminals).map((terminal, index) => (
            <NativeSelectOption key={terminal.id} value={terminal.id}>
              {terminal.title} — {workspaces[terminal.workspace_id]?.name ?? 'Workspace'} ({index + 1})
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {selected && (
        <TerminalAppearanceEditor
          key={`${bootId}:${selected.id}`}
          terminal={selected}
          bootId={bootId}
          settings={settings}
          palettes={palettes}
        />
      )}
    </>
  )
}

function TerminalAppearanceEditor({
  terminal,
  bootId,
  settings,
  palettes,
}: {
  terminal: { id: string; workspace_id: string }
  bootId: string | null
  settings: ProfileSettings
  palettes: BuiltinPalette[]
}) {
  const cache = useQueryClient()
  const appearance = useQuery({
    queryKey: ['terminal-appearance', bootId, terminal.id, settings.appearance_revision],
    queryFn: () => window.adeHost.terminals.appearance(terminal.workspace_id, terminal.id),
    refetchInterval: (query) => (query.state.data?.propagation.state === 'pending' ? 1000 : false),
  })
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ['profile-settings'] })
    void cache.invalidateQueries({ queryKey: ['terminal-appearance'] })
    void cache.invalidateQueries({ queryKey: ['appearance'] })
  }
  const change = useMutation({
    mutationFn: ({ binding, revision }: { binding: ThemeBinding | null; revision: number }) =>
      window.adeHost.terminals.setAppearance(terminal.workspace_id, terminal.id, binding, revision),
    onSettled: refresh,
  })
  const resolved = appearance.data
  const override = resolved?.provenance === 'terminal' ? resolved.binding : null
  const error = change.error ?? appearance.error
  const disabled = !resolved || appearance.isFetching || change.isPending
  const apply = (binding: ThemeBinding | null) => {
    if (resolved && !disabled) change.mutate({ binding, revision: resolved.revision })
  }
  return (
    <>
      <Field data-invalid={Boolean(error)}>
        <FieldLabel id="terminal-override-mode">Override mode</FieldLabel>
        <ToggleGroup
          aria-invalid={Boolean(error)}
          aria-labelledby="terminal-override-mode"
          value={resolved ? [override?.kind ?? 'profile'] : []}
          disabled={disabled}
          variant="outline"
          size="sm"
          onValueChange={(values) => {
            const mode = values[0]
            if (mode === 'profile') apply(null)
            else if (mode === 'follow_app') apply({ kind: mode })
            else if (mode === 'fixed') apply({ kind: mode, theme_id: resolved?.resolved_id ?? settings.app_dark_theme })
            else if (mode === 'paired')
              apply({ kind: mode, light: settings.app_light_theme, dark: settings.app_dark_theme })
          }}
        >
          <ToggleGroupItem value="profile">Use profile theme</ToggleGroupItem>
          <ToggleGroupItem value="follow_app">Follow app</ToggleGroupItem>
          <ToggleGroupItem value="paired">Separate pair</ToggleGroupItem>
          <ToggleGroupItem value="fixed">Fixed theme</ToggleGroupItem>
        </ToggleGroup>
        {resolved && (
          <FieldDescription role="status">
            {resolved.provenance === 'profile' ? 'Using profile theme' : 'Terminal override'}:{' '}
            {palettes.find((palette) => palette.id === resolved.resolved_id)?.name ?? resolved.resolved_id} (
            {resolved.mode}).
          </FieldDescription>
        )}
        {resolved?.diagnostics.map((diagnostic) => (
          <FieldDescription key={diagnostic.slot} role="status">
            {diagnostic.message}
          </FieldDescription>
        ))}
        {resolved?.propagation.state === 'pending' && (
          <FieldDescription role="status">Saved. This terminal’s colors are still updating.</FieldDescription>
        )}
        {resolved?.propagation.state === 'unavailable' && (
          <FieldError>Saved. This terminal’s colors could not be confirmed: {resolved.propagation.message}</FieldError>
        )}
        {resolved && resolved.propagation.state !== 'applied' && (
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => apply(override)}>
            Retry this terminal update
          </Button>
        )}
        {error && <FieldError role="alert">{error.message}</FieldError>}
      </Field>
      {override &&
        override.kind !== 'follow_app' &&
        (override.kind === 'fixed' ? (['fixed'] as const) : (['light', 'dark'] as const)).map((slot) => {
          const id = override.kind === 'fixed' ? override.theme_id : override[slot === 'light' ? 'light' : 'dark']
          const options = palettes.filter((palette) => slot === 'fixed' || palette.mode === slot)
          const update = (theme: string) =>
            apply(override.kind === 'fixed' ? { ...override, theme_id: theme } : { ...override, [slot]: theme })
          return (
            <Field key={slot} data-invalid={Boolean(error)}>
              <FieldLabel id={`override-${slot}-label`} htmlFor={slot === 'fixed' ? `override-${slot}` : undefined}>
                {slot === 'fixed'
                  ? 'Override palette'
                  : slot === 'light'
                    ? 'Light override palette'
                    : 'Dark override palette'}
              </FieldLabel>
              {slot === 'fixed' ? (
                <NativeSelect
                  id={`override-${slot}`}
                  value={id}
                  aria-invalid={Boolean(error)}
                  disabled={disabled}
                  onChange={(event) => update(event.target.value)}
                >
                  {!options.some((palette) => palette.id === id) && (
                    <NativeSelectOption value={id} disabled>
                      {id} (unavailable)
                    </NativeSelectOption>
                  )}
                  {options.map((palette) => (
                    <NativeSelectOption key={palette.id} value={palette.id}>
                      {palette.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <ToggleGroup
                  aria-labelledby={`override-${slot}-label`}
                  aria-invalid={Boolean(error)}
                  value={[id]}
                  disabled={disabled}
                  variant="outline"
                  size="sm"
                  onValueChange={(values) => {
                    if (values[0]) update(values[0])
                  }}
                >
                  {options.map((palette) => (
                    <ToggleGroupItem key={palette.id} value={palette.id}>
                      {palette.name}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </Field>
          )
        })}
    </>
  )
}
