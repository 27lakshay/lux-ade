import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { messageOf } from './ConversationComposerSupport'
import { useDaemon } from '../state/hooks'

const request = (op: string, fields: Record<string, unknown>) =>
  // The MCP operations are typed by the contract; this form builds plain definitions.
  window.adeHost!.conversations.request(op as never, fields as never) as Promise<Record<string, unknown>>

type Server = {
  name: string
  revision: number
  definition: { enabled: boolean; transport: { type: string; command?: string; url?: string } }
}
type Resolution = {
  delivery: string
  wired: boolean
  format: string
  servers: Array<{ name: string }>
  excluded: Array<{ name: string; reason: string }>
}

/**
 * The profile MCP catalog: servers recorded once for the profile, and what each provider would
 * receive in a workspace. ADE runs no gateway; delivery is direct, so each provider negotiates
 * with the server itself. Secrets are references to the environment, never stored values.
 */
export function McpSettings() {
  const queryClient = useQueryClient()
  const workspaceMap = useDaemon((state) => state.workspaces)
  const workspaces = Object.values(workspaceMap)
  const servers = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: async () => (await request('mcp.server.list', {})).servers as Server[],
    retry: false,
  })
  const [draft, setDraft] = useState({ name: '', command: '', args: '' })
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ provider: string; resolution: Resolution } | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })
  const add = async () => {
    setMessage(null)
    try {
      await request('mcp.server.add', {
        name: draft.name.trim(),
        definition: {
          enabled: true,
          installation: { source: 'manual' },
          transport: {
            type: 'stdio',
            command: draft.command.trim(),
            args: draft.args.split(' ').filter(Boolean),
            env: {},
          },
          scope: { kind: 'profile' },
          providers: { kind: 'all' },
        },
      })
      setDraft({ name: '', command: '', args: '' })
      await refresh()
    } catch (error) {
      setMessage("Couldn't add the server. " + messageOf(error))
    }
  }
  const remove = async (server: Server) => {
    try {
      await request('mcp.server.remove', { name: server.name, expected_revision: server.revision })
      await refresh()
    } catch (error) {
      setMessage(`Couldn't remove ${server.name}. ` + messageOf(error))
    }
  }
  const resolve = async (provider: string) => {
    const workspace = workspaces[0]
    if (!workspace) return setMessage('Open a workspace to see what a provider receives.')
    try {
      const resolution = (await request('mcp.resolve', {
        workspace_id: workspace.id,
        provider,
      })) as unknown as Resolution
      setPreview({ provider, resolution })
    } catch (error) {
      setMessage(`Couldn't resolve servers for ${provider}. ` + messageOf(error))
    }
  }
  return (
    <section aria-labelledby="mcp-settings-heading">
      <Card>
        <CardHeader>
          <CardTitle id="mcp-settings-heading" role="heading" aria-level={2}>
            MCP servers
          </CardTitle>
          <CardDescription>
            Recorded once for this profile and passed to each provider directly; ADE runs no MCP gateway.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <ul aria-label="MCP servers" className="flex flex-col gap-1">
              {servers.data?.map((server) => (
                <li key={server.name} className="flex items-center justify-between gap-2">
                  <Caption>
                    {server.name} · {server.definition.transport.type}{' '}
                    {server.definition.transport.command ?? server.definition.transport.url ?? ''} · revision{' '}
                    {server.revision}
                    {server.definition.enabled ? '' : ' · disabled'}
                  </Caption>
                  <Button size="sm" variant="ghost" onClick={() => void remove(server)}>
                    Remove {server.name}
                  </Button>
                </li>
              ))}
            </ul>
            {servers.data?.length === 0 && <Caption tone="muted">No MCP servers are recorded.</Caption>}
            {servers.isError && <Body role="alert">Couldn't read the MCP catalog. {messageOf(servers.error)}</Body>}
            <div className="flex flex-wrap items-end gap-2">
              <Field>
                <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
                <Input
                  id="mcp-name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="mcp-command">Command</FieldLabel>
                <Input
                  id="mcp-command"
                  value={draft.command}
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="mcp-args">Arguments</FieldLabel>
                <Input
                  id="mcp-args"
                  value={draft.args}
                  onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                />
              </Field>
              <Button size="sm" disabled={!draft.name.trim() || !draft.command.trim()} onClick={() => void add()}>
                Add server
              </Button>
            </div>
            <div className="flex gap-2">
              {['codex', 'claude', 'omp'].map((provider) => (
                <Button key={provider} size="sm" variant="outline" onClick={() => void resolve(provider)}>
                  What {provider} receives
                </Button>
              ))}
            </div>
            {preview && (
              <div aria-label="MCP resolution" className="flex flex-col gap-1">
                <Caption>
                  {preview.provider}:{' '}
                  {preview.resolution.wired ? `delivered ${preview.resolution.delivery}` : 'not wired'} as{' '}
                  {preview.resolution.format} · receives{' '}
                  {preview.resolution.servers.map((s) => s.name).join(', ') || 'nothing'}
                </Caption>
                {preview.resolution.excluded.map((entry) => (
                  <Caption key={entry.name} tone="muted">
                    {entry.name} excluded: {entry.reason.replaceAll('_', ' ')}
                  </Caption>
                ))}
              </div>
            )}
            {message && <Body role="alert">{message}</Body>}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
