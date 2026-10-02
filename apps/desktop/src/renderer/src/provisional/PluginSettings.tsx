import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PluginGeneration, PluginSummary } from '@ade/contracts'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { messageOf } from './ConversationComposerSupport'
import { refreshPluginUi } from '../plugins/ui-host'

const host = () => window.adeHost!.conversations

/**
 * Installed plugins with each activation generation: the artifact version and digest it runs,
 * its state, and how many provider sessions lease it. Disabling discloses its consequences before
 * it happens; closing a conversation view is not this, and stops nothing.
 */
function PluginRow({ plugin }: { plugin: PluginSummary }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const generations = useQuery({
    queryKey: ['plugin-generations', plugin.id],
    queryFn: async () => (await host().request('plugin.generation.list', { plugin_id: plugin.id })).generations,
    retry: false,
  })
  const leases = (generations.data ?? []).reduce((total: number, g: PluginGeneration) => total + g.provider_leases, 0)
  const change = async (op: 'plugin.enable' | 'plugin.disable') => {
    setMessage(null)
    try {
      await host().request(op, { plugin_id: plugin.id })
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: ['plugins'] })
      await queryClient.invalidateQueries({ queryKey: ['plugin-generations', plugin.id] })
      // This window's plugin UI follows the change now rather than on its next refresh.
      await refreshPluginUi()
    } catch (error) {
      setMessage(messageOf(error))
    }
  }
  return (
    <li className="flex flex-col gap-1">
      <Caption>
        {plugin.name} {plugin.version} · {plugin.status} · generation {plugin.activation_generation} · data schema{' '}
        {plugin.data_schema}
      </Caption>
      <ul aria-label={`Generations of ${plugin.name}`} className="flex flex-col">
        {generations.data?.map((generation) => (
          <li key={generation.generation}>
            <Caption tone="muted">
              Generation {generation.generation}: version {generation.version} (
              {generation.artifact_digest.slice(0, 12)}) · {generation.state} · {generation.provider_leases} provider{' '}
              {generation.provider_leases === 1 ? 'session leases' : 'sessions lease'} it
            </Caption>
          </li>
        ))}
      </ul>
      {plugin.status === 'enabled' ? (
        confirming ? (
          <div role="alertdialog" aria-label={`Disable ${plugin.name}`} className="flex flex-col gap-1">
            <Body>
              Disabling stops this plugin's host, its commands and its registrations.{' '}
              {leases > 0
                ? `${leases} provider ${leases === 1 ? 'session keeps' : 'sessions keep'} running on the version ${leases === 1 ? 'it' : 'they'} started on until ${leases === 1 ? 'it ends' : 'they end'}; no new work starts on it.`
                : 'No provider session runs on it now.'}{' '}
              Retained conversation history stays readable.
            </Body>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void change('plugin.disable')}>
                Disable {plugin.name}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
                Keep enabled
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="self-start" onClick={() => setConfirming(true)}>
            Disable…
          </Button>
        )
      ) : (
        <Button size="sm" variant="outline" className="self-start" onClick={() => void change('plugin.enable')}>
          Enable {plugin.name}
        </Button>
      )}
      {message && <Body role="alert">{message}</Body>}
    </li>
  )
}

export function PluginSettings() {
  const plugins = useQuery({
    queryKey: ['plugins'],
    queryFn: async () => (await host().request('plugin.list', {})).plugins,
    retry: false,
  })
  return (
    <section aria-labelledby="plugin-settings-heading">
      <Card>
        <CardHeader>
          <CardTitle id="plugin-settings-heading" role="heading" aria-level={2}>
            Plugins
          </CardTitle>
          <CardDescription>
            Closing a conversation view only detaches the view; it never stops a plugin or its work.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul aria-label="Installed plugins" className="flex flex-col gap-3">
            {plugins.data?.map((plugin) => (
              <PluginRow key={plugin.id} plugin={plugin} />
            ))}
          </ul>
          {plugins.data?.length === 0 && <Caption tone="muted">No plugins are installed.</Caption>}
          {plugins.isError && <Body role="alert">Couldn't list plugins. {messageOf(plugins.error)}</Body>}
        </CardContent>
      </Card>
    </section>
  )
}
