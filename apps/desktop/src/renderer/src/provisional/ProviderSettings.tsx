import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Body, Title } from '@/components/Typography'
import { useState } from 'react'
export function ProviderSettings() {
  const [providerDraft, setProviderDraft] = useState('')
  const provider = providerDraft.trim()
  const isPluginProvider = provider.startsWith('plugin:') && provider.length > 'plugin:'.length
  const inspection = useQuery({
    queryKey: ['provider-inspect', provider],
    queryFn: () => window.adeHost.conversations.request('provider.inspect', { provider }),
    enabled: false,
    retry: false,
  })
  const inspectionResult = !inspection.isFetching && !inspection.isError ? inspection.data : undefined
  const readiness = useQuery({
    queryKey: ['provider-readiness', provider, inspection.dataUpdatedAt],
    queryFn: () => window.adeHost.conversations.request('provider.readiness', { provider }),
    enabled: false,
    retry: false,
  })
  const readinessResult =
    !inspection.isFetching && !inspection.isError && !readiness.isFetching && !readiness.isError
      ? readiness.data
      : undefined
  const canCheckReadiness = Boolean(inspectionResult?.descriptor)

  return (
    <section aria-labelledby="provider-settings-heading">
      <Card>
        <CardHeader>
          <CardTitle id="provider-settings-heading" role="heading" aria-level={2}>
            Provider SDK inspection
          </CardTitle>
          <CardDescription>
            Inspect an enabled plugin worker and check readiness without submitting native provider work.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-settings-id">Plugin provider ID</FieldLabel>
              <Input
                id="provider-settings-id"
                aria-describedby="provider-settings-id-description"
                autoComplete="off"
                placeholder="plugin:e2e.sdk-diagnostic"
                value={providerDraft}
                onChange={(event) => setProviderDraft(event.target.value)}
              />
              <FieldDescription id="provider-settings-id-description">
                Enter the full plugin-qualified provider ID.
              </FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!isPluginProvider || inspection.isFetching}
                onClick={() => void inspection.refetch()}
                size="sm"
              >
                {inspection.isFetching && <Spinner aria-hidden="true" data-icon="inline-start" />}
                {inspection.isFetching ? 'Inspecting provider' : 'Inspect provider'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!canCheckReadiness || readiness.isFetching}
                onClick={() => void readiness.refetch()}
                size="sm"
              >
                {readiness.isFetching && <Spinner aria-hidden="true" data-icon="inline-start" />}
                {readiness.isFetching ? 'Checking readiness' : 'Check readiness'}
              </Button>
            </div>
            {inspection.isFetching && <FieldDescription role="status">Inspecting provider…</FieldDescription>}
            {readiness.isFetching && <FieldDescription role="status">Checking read-only readiness…</FieldDescription>}
          </FieldGroup>

          {inspection.isError && (
            <Alert className="mt-6" variant="destructive">
              <AlertTitle>Provider inspection failed</AlertTitle>
              <AlertDescription>
                {inspection.error instanceof Error ? inspection.error.message : String(inspection.error)}
              </AlertDescription>
            </Alert>
          )}

          {inspectionResult && !inspectionResult.descriptor && (
            <Alert className="mt-6">
              <AlertTitle>
                Provider inspection: <Badge variant="outline">{inspectionResult.state}</Badge>
              </AlertTitle>
              <AlertDescription>{inspectionResult.reason}</AlertDescription>
            </Alert>
          )}

          {inspectionResult?.descriptor && (
            <Card className="mt-6" size="sm">
              <CardHeader>
                <CardTitle role="heading" aria-level={3}>
                  {inspectionResult.descriptor.name}
                </CardTitle>
                <CardDescription>
                  <span role="status">Inspection complete: {inspectionResult.state}.</span> {inspectionResult.reason}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <section aria-labelledby="provider-version-heading">
                    <Title as="h4" id="provider-version-heading">
                      Provider version
                    </Title>
                    <Body>{inspectionResult.version ?? 'Not reported'}</Body>
                  </section>
                  <section aria-labelledby="provider-protocol-heading">
                    <Title as="h4" id="provider-protocol-heading">
                      Protocol compatibility
                    </Title>
                    <dl className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <dt>Protocol version</dt>
                        <dd>{inspectionResult.descriptor.protocol_version}</dd>
                      </div>
                      <div>
                        <dt>Compatible protocol versions</dt>
                        <dd>
                          {inspectionResult.descriptor.compatible_protocol_versions.join(', ') || 'None declared'}
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <section aria-labelledby="provider-permissions-heading">
                    <Title as="h4" id="provider-permissions-heading">
                      Permission modes
                    </Title>
                    {inspectionResult.descriptor.permission_modes.length === 0 ? (
                      <Body>No permission modes declared.</Body>
                    ) : (
                      <ul className="flex flex-wrap gap-2">
                        {inspectionResult.descriptor.permission_modes.map((mode) => (
                          <li key={mode}>
                            <Badge variant="outline">{mode}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section aria-labelledby="provider-limits-heading">
                    <Title as="h4" id="provider-limits-heading">
                      Worker limits
                    </Title>
                    <dl className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <dt>Maximum input frame bytes</dt>
                        <dd>{inspectionResult.descriptor.limits.max_input_frame_bytes}</dd>
                      </div>
                      <div>
                        <dt>Maximum input entries</dt>
                        <dd>{inspectionResult.descriptor.limits.max_input_entries}</dd>
                      </div>
                      <div>
                        <dt>Maximum initialize time (ms)</dt>
                        <dd>{inspectionResult.descriptor.limits.max_initialize_ms}</dd>
                      </div>
                      <div>
                        <dt>Maximum output frame bytes</dt>
                        <dd>{inspectionResult.descriptor.limits.max_output_frame_bytes}</dd>
                      </div>
                      <div>
                        <dt>Maximum output entries</dt>
                        <dd>{inspectionResult.descriptor.limits.max_output_entries}</dd>
                      </div>
                      <div>
                        <dt>Maximum concurrent operations</dt>
                        <dd>{inspectionResult.descriptor.limits.max_concurrency}</dd>
                      </div>
                      <div>
                        <dt>Maximum partial frame time (ms)</dt>
                        <dd>{inspectionResult.descriptor.limits.max_partial_frame_ms}</dd>
                      </div>
                      <div>
                        <dt>Maximum operation time (ms)</dt>
                        <dd>{inspectionResult.descriptor.limits.max_operation_ms}</dd>
                      </div>
                      <div>
                        <dt>Maximum cleanup time (ms)</dt>
                        <dd>{inspectionResult.descriptor.limits.max_cleanup_ms}</dd>
                      </div>
                    </dl>
                  </section>
                  <section aria-labelledby="provider-requirements-heading">
                    <Title as="h4" id="provider-requirements-heading">
                      SDK runtime requirements
                    </Title>
                    <dl className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <dt>SDK API version</dt>
                        <dd>{inspectionResult.descriptor.requirements.sdk_api_version}</dd>
                      </div>
                      <div>
                        <dt>SDK version</dt>
                        <dd>{inspectionResult.descriptor.requirements.sdk_version}</dd>
                      </div>
                      <div>
                        <dt>Node engine</dt>
                        <dd>{inspectionResult.descriptor.requirements.node_engine}</dd>
                      </div>
                      <div>
                        <dt>Platform Node version</dt>
                        <dd>{inspectionResult.descriptor.requirements.platform_node_version}</dd>
                      </div>
                      <div>
                        <dt>Effect version</dt>
                        <dd>{inspectionResult.descriptor.requirements.effect_version}</dd>
                      </div>
                    </dl>
                  </section>
                  <section aria-labelledby="provider-capabilities-heading">
                    <Title as="h4" id="provider-capabilities-heading">
                      Capabilities
                    </Title>
                    {inspectionResult.descriptor.capabilities.length === 0 ? (
                      <Body>No capabilities declared.</Body>
                    ) : (
                      <ul className="flex flex-col gap-3">
                        {inspectionResult.descriptor.capabilities.map((capability) => (
                          <li className="flex flex-col gap-1" key={capability.name}>
                            <div className="flex flex-wrap items-center gap-2">
                              <span>{capability.name}</span>
                              <Badge variant={capability.available ? 'secondary' : 'outline'}>
                                {capability.available ? 'Available' : 'Unavailable'}
                              </Badge>
                              <Badge variant="outline">{capability.support}</Badge>
                            </div>
                            {capability.reason && <Body>{capability.reason}</Body>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section aria-labelledby="provider-operations-heading">
                    <Title as="h4" id="provider-operations-heading">
                      Operations
                    </Title>
                    <ul className="flex flex-col gap-3">
                      {inspectionResult.descriptor.operations.map((operation) => (
                        <li className="flex flex-col gap-1" key={operation.method}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span>{operation.method}</span>
                            <Badge variant={operation.availability === 'available' ? 'secondary' : 'outline'}>
                              {operation.availability}
                            </Badge>
                            <Badge variant="outline">{operation.tier}</Badge>
                          </div>
                          {operation.reason && <Body>{operation.reason}</Body>}
                        </li>
                      ))}
                    </ul>
                  </section>
                </FieldGroup>
              </CardContent>
            </Card>
          )}

          {!inspection.data && !inspection.isFetching && !inspection.isError && (
            <Empty className="mt-6 min-h-0">
              <EmptyHeader>
                <EmptyTitle>Inspect a plugin provider</EmptyTitle>
                <EmptyDescription>
                  Enter an enabled plugin provider ID to read its SDK descriptor and runtime requirements.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {readiness.isError && (
            <Alert className="mt-6" variant="destructive">
              <AlertTitle>Readiness check failed</AlertTitle>
              <AlertDescription>
                {readiness.error instanceof Error ? readiness.error.message : String(readiness.error)}
              </AlertDescription>
            </Alert>
          )}

          {readinessResult && (
            <section aria-labelledby="provider-readiness-heading">
              <Card className="mt-6" size="sm">
                <CardHeader>
                  <CardTitle id="provider-readiness-heading" role="heading" aria-level={3}>
                    Read-only readiness
                  </CardTitle>
                  <CardDescription>
                    <Badge variant={readinessResult.state === 'ready' ? 'secondary' : 'outline'}>
                      {readinessResult.state}
                    </Badge>{' '}
                    {readinessResult.reason}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="flex flex-col gap-3">
                    {readinessResult.checks.map((check) => (
                      <li className="flex flex-col gap-1" key={check.check}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{check.check}</span>
                          <Badge
                            variant={
                              check.state === 'failed'
                                ? 'destructive'
                                : check.state === 'passed'
                                  ? 'secondary'
                                  : 'outline'
                            }
                          >
                            {check.state}
                          </Badge>
                        </div>
                        <Body>{check.detail}</Body>
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  <FieldDescription>No account was selected; native provider operations were not run.</FieldDescription>
                </CardFooter>
              </Card>
            </section>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
