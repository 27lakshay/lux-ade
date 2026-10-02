import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FieldError, FieldGroup } from '@/components/ui/field'
import { Body, Caption } from '@/components/Typography'
import { FullScreen } from './FullScreen'
import { applyThemePreference } from '../app/theme'

/** The plugin UI contributions this window did not load, so a person knows what is off. */
function DisabledPluginUi() {
  const entries = useQuery({
    queryKey: ['plugin-ui-entries'],
    queryFn: () => window.adeHost.conversations.pluginUiEntries(),
    retry: false,
  })
  if (!entries.data?.length) return null
  return (
    <section aria-label="Plugin UI not loaded" className="flex flex-col gap-1">
      <Body>Plugin UI is not loaded in safe mode. Their messages and drafts show as plain text:</Body>
      <ul className="flex flex-col gap-1">
        {entries.data.map((entry) => (
          <li key={entry.plugin_id}>
            <Caption>
              {entry.name} {entry.version} (generation {entry.generation})
              {[...entry.timeline, ...entry.composer].length > 0 &&
                ': ' + [...entry.timeline, ...entry.composer].map((item) => item.title).join(', ')}
            </Caption>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function SafeModeRecovery() {
  const [continued, setContinued] = useState(false)
  const cache = useQueryClient()
  const settings = useQuery({ queryKey: ['profile-settings'], queryFn: () => window.adeHost.settings.get() })
  const recovery = useMutation({
    mutationFn: () => {
      if (!settings.data) throw new Error('Profile settings are not available yet.')
      return window.adeHost.settings.resetAppearance(settings.data.appearance_revision)
    },
    onSuccess: async (saved) => {
      cache.setQueryData(['profile-settings'], saved)
      applyThemePreference(saved.appearance)
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['appearance'] }),
        cache.invalidateQueries({ queryKey: ['appearance-startup-status'] }),
      ])
    },
    onError: () => void cache.invalidateQueries({ queryKey: ['profile-settings'] }),
  })
  const error = recovery.error ?? settings.error
  const workspaceUrl = new URL(window.location.href)
  workspaceUrl.searchParams.delete('safeMode')
  workspaceUrl.hash = '/'

  // The workspace underneath keeps running without plugin UI: Stop, pending requests and drafts.
  if (continued) return null
  return (
    <FullScreen title="Safe mode recovery" backHref={workspaceUrl.toString()}>
      <FieldGroup className="mt-6">
        <Alert>
          <AlertTitle>Safe mode is active</AlertTitle>
          <AlertDescription>
            This window started with safe mode enabled. Your terminals and other work remain in the background. Restore
            the core appearance defaults here; this does not change or stop that work.
          </AlertDescription>
        </Alert>
        <DisabledPluginUi />
        <Button size="default" variant="outline" onClick={() => setContinued(true)}>
          Continue in safe mode
        </Button>
        {settings.data && (
          <Body>
            Current app colors: {settings.data.app_light_theme} (light) and {settings.data.app_dark_theme} (dark).
          </Body>
        )}
        {error && <FieldError role="alert">Appearance defaults could not be restored: {error.message}</FieldError>}
        {recovery.isSuccess && <Body role="status">Core appearance defaults restored.</Body>}
        <Button
          size="default"
          disabled={!settings.data || settings.isFetching || recovery.isPending}
          onClick={() => recovery.mutate()}
        >
          Restore core appearance defaults
        </Button>
        {settings.isError && <Body>Reopen ADE after checking the daemon connection.</Body>}
      </FieldGroup>
    </FullScreen>
  )
}
