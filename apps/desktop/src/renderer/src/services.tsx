import React from 'react'
import type { Workspace } from '@ade/client'
import type { Frame } from './types'

type Service = { name: string; identity: string; workspace_id: string; terminal_id: string | null; terminal_owner: Frame | null; ports: Record<string, number>;
  config: { program: string; peers?: Record<string, { service: string; port_variable: string }> } }
type ServiceState = { state: string; metrics: Frame | null }
type ServiceList = { services: Service[]; states: Record<string, ServiceState> }
type ListenerInventory = { coverage: string; listeners: Array<{ address: string; port: number; pid: number; ownership: string }>;
  assignments: Array<{ workspace_id: string; service_name: string; variable: string; port: number; observation: string }> }
type ServiceInspection = { execution_state: string; execution_error?: string | null;
  readiness: { state: string; application_ready: string; observation_error?: string | null };
  logs: { available: boolean; bytes_base64?: string; truncated?: boolean; reason?: string };
  durable_logs?: { available: boolean; bytes_base64?: string; truncated?: boolean;
    retention_overflow?: boolean; segment_gap?: boolean; reason?: string; capture_error?: string;
    run_transfer_id?: string; start_offset?: number; through_offset?: number; coverage?: string };
  health_monitor?: { state: string; basis?: string; status_code?: number; sampled_at_ms?: number;
    fresh_until_ms?: number; schedule_delay_ms?: number };
  effective_peers?: Record<string, string>; peer_error?: string | null;
  health?: { state: string; basis: string; status_code?: number; error?: string } }
type ProxyRoute = { url: string; port: number; route_id: string; service_identity: string; target_port: number }
type ProxyRecoveryRoute = Omit<ProxyRoute, 'url'> & { url: string | null; workspace_id: string; name: string;
  port_variable: string; availability: string; reason?: string }
type ProxyRecovery = { status: 'healthy' | 'degraded' | 'corrupt'; routes: ProxyRecoveryRoute[];
  registry_sha256?: string; reason?: string }

function proxyRoute(value: Frame): ProxyRoute {
  if (typeof value.url !== 'string' || typeof value.route_id !== 'string' ||
    typeof value.service_identity !== 'string' || !Number.isSafeInteger(value.port) ||
    !Number.isSafeInteger(value.target_port)) throw new Error('Invalid service proxy route')
  return value as ProxyRoute
}

function serviceOutput(logs: ServiceInspection['logs']): string {
  if (!logs.available || !logs.bytes_base64) return ''
  try { return new TextDecoder().decode(Uint8Array.from(atob(logs.bytes_base64), (character) => character.charCodeAt(0))) }
  catch { return 'Output could not be decoded' }
}

export function ServicePane({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const [list, setList] = React.useState<ServiceList | null>(null)
  const [inventory, setInventory] = React.useState<ListenerInventory | null>(null)
  const [inspection, setInspection] = React.useState<ServiceInspection | null>(null)
  const [detailName, setDetailName] = React.useState<string | null>(null)
  const [healthPort, setHealthPort] = React.useState('')
  const [healthPath, setHealthPath] = React.useState('/')
  const [healthResult, setHealthResult] = React.useState<{ name: string; value: NonNullable<ServiceInspection['health']> } | null>(null)
  const [healthBusy, setHealthBusy] = React.useState(false)
  const [proxyBusy, setProxyBusy] = React.useState('')
  const [proxyUrls, setProxyUrls] = React.useState<Record<string, string>>({})
  const [proxyRouteMeta, setProxyRouteMeta] = React.useState<Record<string, ProxyRoute>>({})
  const [proxyRemap, setProxyRemap] = React.useState<Record<string, { identity: string; port: number }>>({})
  const [proxyRecovery, setProxyRecovery] = React.useState<ProxyRecovery | null>(null)
  const [proxyRecoveryBusy, setProxyRecoveryBusy] = React.useState(false)
  const [confirmProxyReset, setConfirmProxyReset] = React.useState(false)
  const [proxyArchive, setProxyArchive] = React.useState('')
  const healthRequest = React.useRef(0)
  const [inventoryError, setInventoryError] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  React.useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const [services, listeners] = await Promise.allSettled([
          window.adeHost.requestService('service.list', { workspace_id: workspace.id }),
          window.adeHost.requestService('listener.list', {}),
        ])
        if (disposed) return
        if (services.status === 'fulfilled') { setList(services.value as ServiceList); setError('') }
        else setError(String(services.reason))
        if (listeners.status === 'fulfilled') {
          setInventory(listeners.value as ListenerInventory)
          setInventoryError('')
        } else {
          setInventory(null)
          setInventoryError(String(listeners.reason))
        }
      } finally { if (!disposed) timer = setTimeout(() => { void load() }, 3000) }
    }
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [workspace.id, refresh])
  React.useEffect(() => {
    if (!detailName) { setInspection(null); return }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const result = await window.adeHost.requestService('service.inspect', {
          workspace_id: workspace.id, name: detailName, tail_bytes: 4096,
        })
        if (!disposed) { setInspection(result as ServiceInspection); setError('') }
      } catch (reason) { if (!disposed) { setInspection(null); setError(String(reason)) } }
      finally { if (!disposed) timer = setTimeout(() => { void load() }, 3000) }
    }
    setInspection(null)
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [workspace.id, detailName, refresh])
  const change = async (name: string, action: 'start' | 'stop'): Promise<void> => {
    if (busy) return
    setBusy(name)
    healthRequest.current++
    setHealthResult(null)
    try {
      await window.adeHost.requestService(`service.${action}`, { workspace_id: workspace.id, name })
      setError('')
      setRefresh((value) => value + 1)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy('') }
  }
  const checkHealth = async (name: string): Promise<void> => {
    if (healthBusy || !healthPort) return
    const request = ++healthRequest.current
    setHealthBusy(true)
    setHealthResult(null)
    try {
      const result = await window.adeHost.requestService('service.inspect', {
        workspace_id: workspace.id, name, tail_bytes: 4096,
        health_check: { port_variable: healthPort, path: healthPath, timeout_ms: 500 },
      }) as ServiceInspection
      if (request === healthRequest.current && result.health) {
        setHealthResult({ name, value: result.health })
        setError('')
      }
    } catch (reason) { if (request === healthRequest.current) setError(String(reason)) }
    finally { if (request === healthRequest.current) setHealthBusy(false) }
  }
  const ensureUrl = async (service: Service, variable: string): Promise<void> => {
    if (proxyBusy) return
    const name = service.name
    const key = `${name}:${variable}`
    setProxyBusy(`${name}:${variable}`)
    try {
      const result = await window.adeHost.requestService('service.proxy.ensure', {
        workspace_id: workspace.id, name, port_variable: variable,
      })
      const route = proxyRoute(result)
      setProxyUrls((urls) => ({ ...urls, [key]: route.url }))
      setProxyRouteMeta((routes) => ({ ...routes, [key]: route }))
      setProxyRemap((routes) => { const next = { ...routes }; delete next[key]; return next })
      setError('')
    } catch (reason) {
      setError(String(reason))
      if (String(reason).includes('Service target changed')) {
        try {
          const route = await window.adeHost.requestService('service.proxy.inspect', {
            workspace_id: workspace.id, name, port_variable: variable,
          })
          const pinned = proxyRoute(route)
          if (pinned.service_identity !== service.identity || pinned.target_port !== service.ports[variable]) {
            setProxyRemap((routes) => ({ ...routes, [key]: {
              identity: pinned.service_identity, port: pinned.target_port,
            } }))
            setProxyUrls((urls) => ({ ...urls, [key]: pinned.url }))
            setProxyRouteMeta((routes) => ({ ...routes, [key]: pinned }))
          }
        } catch { /* The original error remains visible. */ }
      }
    }
    finally { setProxyBusy('') }
  }
  const remapUrl = async (service: Service, variable: string, previous: { identity: string; port: number }): Promise<void> => {
    if (proxyBusy) return
    const key = `${service.name}:${variable}`
    setProxyBusy(key)
    try {
      const result = await window.adeHost.requestService('service.proxy.remap', {
        workspace_id: workspace.id, name: service.name, port_variable: variable,
        expected_service_identity: service.identity, expected_target_port: service.ports[variable],
        expected_route_identity: previous.identity, expected_route_port: previous.port,
      })
      const route = proxyRoute(result)
      setProxyUrls((urls) => ({ ...urls, [key]: route.url }))
      setProxyRouteMeta((routes) => ({ ...routes, [key]: route }))
      setProxyRemap((routes) => { const next = { ...routes }; delete next[key]; return next })
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setProxyBusy('') }
  }
  const retireUrl = async (service: Service, variable: string, route: ProxyRoute): Promise<void> => {
    if (proxyBusy) return
    const key = `${service.name}:${variable}`
    setProxyBusy(key)
    try {
      await window.adeHost.requestService('service.proxy.retire', {
        workspace_id: workspace.id, name: service.name, port_variable: variable,
        expected_route_id: route.route_id, expected_service_identity: route.service_identity,
        expected_target_port: route.target_port, expected_proxy_port: route.port,
      })
      setProxyUrls((urls) => { const next = { ...urls }; delete next[key]; return next })
      setProxyRouteMeta((routes) => { const next = { ...routes }; delete next[key]; return next })
      setProxyRemap((routes) => { const next = { ...routes }; delete next[key]; return next })
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setProxyBusy('') }
  }
  const inspectProxyRecovery = async (): Promise<void> => {
    if (proxyRecoveryBusy) return
    setProxyRecoveryBusy(true)
    try {
      const result = await window.adeHost.requestService('service.proxy.recovery.inspect', {}) as ProxyRecovery
      setProxyRecovery(result)
      setConfirmProxyReset(false)
      setError('')
    } catch (reason) { setProxyRecovery(null); setError(String(reason)) }
    finally { setProxyRecoveryBusy(false) }
  }
  const retryProxyRoute = async (route: ProxyRecoveryRoute): Promise<void> => {
    if (proxyRecoveryBusy) return
    setProxyRecoveryBusy(true)
    try {
      const result = await window.adeHost.requestService('service.proxy.recovery.retry', {
        workspace_id: route.workspace_id, name: route.name, port_variable: route.port_variable,
        expected_route_id: route.route_id, expected_service_identity: route.service_identity,
        expected_target_port: route.target_port, expected_proxy_port: route.port,
      })
      const rebound = proxyRoute(result)
      const key = `${route.name}:${route.port_variable}`
      setProxyUrls((urls) => ({ ...urls, [key]: rebound.url }))
      setProxyRouteMeta((routes) => ({ ...routes, [key]: rebound }))
      setProxyRecovery(await window.adeHost.requestService('service.proxy.recovery.inspect', {}) as ProxyRecovery)
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setProxyRecoveryBusy(false) }
  }
  const retireBlockedProxyRoute = async (route: ProxyRecoveryRoute): Promise<void> => {
    if (proxyRecoveryBusy) return
    setProxyRecoveryBusy(true)
    try {
      await window.adeHost.requestService('service.proxy.retire', {
        workspace_id: route.workspace_id, name: route.name, port_variable: route.port_variable,
        expected_route_id: route.route_id, expected_service_identity: route.service_identity,
        expected_target_port: route.target_port, expected_proxy_port: route.port,
      })
      const key = `${route.name}:${route.port_variable}`
      setProxyUrls((urls) => { const next = { ...urls }; delete next[key]; return next })
      setProxyRouteMeta((routes) => { const next = { ...routes }; delete next[key]; return next })
      setProxyRecovery(await window.adeHost.requestService('service.proxy.recovery.inspect', {}) as ProxyRecovery)
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setProxyRecoveryBusy(false) }
  }
  const resetProxyRegistry = async (): Promise<void> => {
    if (proxyRecoveryBusy || !confirmProxyReset || !proxyRecovery?.registry_sha256) return
    setProxyRecoveryBusy(true)
    try {
      const result = await window.adeHost.requestService('service.proxy.recovery.reset', {
        expected_registry_sha256: proxyRecovery.registry_sha256, confirm_reset: true,
      })
      setProxyArchive(String(result.archive ?? ''))
      setProxyRecovery(await window.adeHost.requestService('service.proxy.recovery.inspect', {}) as ProxyRecovery)
      setConfirmProxyReset(false)
      setError('')
    } catch (reason) { setError(String(reason)); setConfirmProxyReset(false) }
    finally { setProxyRecoveryBusy(false) }
  }
  const openPreview = async (url: string): Promise<void> => {
    try { await window.adeHost.browser.open(url); setError('') }
    catch (reason) { setError(String(reason)) }
  }
  return <section className="service-pane" aria-label="Workspace services">
    <div className="service-heading"><h2>Services</h2><div className="service-actions">
      <button type="button" disabled={proxyRecoveryBusy} onClick={() => void inspectProxyRecovery()}>Inspect URL recovery</button>
      <button onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
    </div></div>
    <p className="muted">Configured services keep running when this window closes. TCP observation does not verify application health.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {proxyRecovery && <section className="service-recovery" aria-label="URL recovery">
      <p role="status">Local URL registry: {proxyRecovery.status}</p>
      {proxyRecovery.status === 'corrupt' && <>
        <p role="alert">{proxyRecovery.reason ?? 'The saved URL registry cannot be read.'} Existing URLs are unavailable until the registry is repaired.</p>
        {proxyRecovery.registry_sha256 ? <>
          <p>Restore a known-good registry offline if available. Otherwise, archive the current bytes and reset the registry. Reset discards saved URL routes.</p>
          {!confirmProxyReset ? <button type="button" disabled={proxyRecoveryBusy}
            onClick={() => setConfirmProxyReset(true)}>Review archive and reset</button> : <div className="service-actions">
            <button type="button" disabled={proxyRecoveryBusy} onClick={() => void resetProxyRegistry()}>Confirm archive and reset</button>
            <button type="button" disabled={proxyRecoveryBusy} onClick={() => setConfirmProxyReset(false)}>Cancel</button>
          </div>}
        </> : <p>Repair the registry offline; this file cannot be safely archived from ADE.</p>}
      </>}
      {proxyRecovery.routes.filter((route) => route.workspace_id === workspace.id && route.availability === 'port_occupied')
        .map((route) => <div className="service-recovery-route" key={route.route_id}>
          <p>{route.name}.{route.port_variable}: original local URL on port {route.port} is blocked. {route.reason}</p>
          <button type="button" disabled={proxyRecoveryBusy} onClick={() => void retryProxyRoute(route)}>
            Retry original URL for {route.name}.{route.port_variable}
          </button>
          <button type="button" disabled={proxyRecoveryBusy} onClick={() => void retireBlockedProxyRoute(route)}>
            Retire blocked URL for {route.name}.{route.port_variable}
          </button>
        </div>)}
      {proxyArchive && <p role="status">Previous registry archived at {proxyArchive}</p>}
    </section>}
    {inventoryError && <p role="status" className="muted">Listener observation unavailable: {inventoryError}</p>}
    {!list && !error && <p className="muted">Loading services…</p>}
    {list?.services.length === 0 && <p className="muted">No services configured in this workspace. Use the ADE CLI to add one.</p>}
    {list?.services.map((service) => {
      const state = list.states[service.name]?.state ?? 'unavailable'
      const owned = Boolean(service.terminal_owner)
      return <article className="service-row" key={service.name} aria-label={`Service ${service.name}`}>
        <div><strong>{service.name}</strong><span className="service-state">{state}</span></div>
        <p>{service.config.program}</p>
        <p className="service-ports">{Object.entries(service.ports).map(([variable, port]) => {
          const observation = inventory?.assignments.find((item) => item.workspace_id === workspace.id &&
            item.service_name === service.name && item.variable === variable && item.port === port)?.observation ?? (inventory ? 'unknown' : 'unavailable')
          return `${variable}=${port} (${observation.replaceAll('_', ' ')})`
        }).join(' · ') || 'No assigned ports'}</p>
        {Object.entries(service.config.peers ?? {}).map(([variable, peer]) =>
          <p className="service-ports" key={variable}>{variable} ← {peer.service}.{peer.port_variable}</p>)}
        <div className="service-actions">
          <button disabled={Boolean(busy) || owned} onClick={() => void change(service.name, 'start')}>Start</button>
          <button disabled={Boolean(busy) || !owned} onClick={() => void change(service.name, 'stop')}>Stop</button>
          <button type="button" aria-expanded={detailName === service.name} onClick={() => {
            healthRequest.current++
            setHealthBusy(false)
            setHealthResult(null)
            setHealthPort(Object.keys(service.ports)[0] ?? '')
            setDetailName((value) => value === service.name ? null : service.name)
          }}>{detailName === service.name ? 'Hide details' : 'Inspect'}</button>
        </div>
        {detailName === service.name && <div className="service-inspection">
          {!inspection ? <p className="muted">Loading service details…</p> : <>
            <p>Execution: {inspection.execution_state} · TCP: {inspection.readiness.state.replaceAll('_', ' ')} · Application health: {inspection.readiness.application_ready}</p>
            {Object.keys(service.ports).length > 0 && <div className="service-health">
              <label>Health port <select value={healthPort} onChange={(event) => { setHealthPort(event.target.value); setHealthResult(null) }}>
                {Object.keys(service.ports).map((variable) => <option key={variable} value={variable}>{variable}</option>)}
              </select></label>
              <label>Health path <input value={healthPath} onChange={(event) => { setHealthPath(event.target.value); setHealthResult(null) }} /></label>
              <button type="button" disabled={healthBusy || !healthPort} onClick={() => void checkHealth(service.name)}>Check HTTP</button>
            </div>}
            {Object.keys(service.ports).map((variable) => {
              const key = `${service.name}:${variable}`
              const url = proxyUrls[key]
              return <div className="service-health" key={variable}>
                <button type="button" disabled={Boolean(proxyBusy)} onClick={() => void ensureUrl(service, variable)}>
                  Local URL for {variable}
                </button>
                {url && <><span className="service-ports">{url}</span>
                  <button type="button" onClick={() => void openPreview(url)}>Open preview</button>
                  {proxyRouteMeta[key] && <button type="button" disabled={Boolean(proxyBusy)}
                    onClick={() => void retireUrl(service, variable, proxyRouteMeta[key])}>
                    Retire local URL for {variable}
                  </button>}</>}
                {proxyRemap[key] && <button type="button" disabled={Boolean(proxyBusy)}
                  onClick={() => void remapUrl(service, variable, proxyRemap[key])}>
                  Remap URL to this service
                </button>}
              </div>
            })}
            {healthResult?.name === service.name && <p role="status">Last HTTP check: {healthResult.value.state.replaceAll('_', ' ')}
              {healthResult.value.status_code ? ` (${healthResult.value.status_code})` : ''}
              {healthResult.value.error ? ` · ${healthResult.value.error}` : ''}</p>}
            {inspection.health_monitor && inspection.health_monitor.state !== 'disabled' &&
              <p role="status">Monitored HTTP: {inspection.health_monitor.state.replaceAll('_', ' ')}
                {inspection.health_monitor.status_code ? ` (${inspection.health_monitor.status_code})` : ''}
                {inspection.health_monitor.basis ? ` · ${inspection.health_monitor.basis.replaceAll('_', ' ')}` : ''}
                {inspection.health_monitor.sampled_at_ms ? ` · sampled ${new Date(inspection.health_monitor.sampled_at_ms).toLocaleTimeString()}` : ''}
              </p>}
            {(inspection.execution_error || inspection.readiness.observation_error) &&
              <p role="alert">{inspection.execution_error || inspection.readiness.observation_error}</p>}
            {inspection.peer_error && <p role="alert">Peer unavailable: {inspection.peer_error}</p>}
            {Object.entries(inspection.effective_peers ?? {}).map(([variable, url]) =>
              <p className="service-ports" key={variable}>Effective {variable}: {url}</p>)}
            <h3>Recorded output</h3>
            {inspection.durable_logs?.available ? <>
              <pre>{serviceOutput(inspection.durable_logs) || 'No output yet'}</pre>
              <p>Recorded output contains captured bytes only; it may be incomplete.</p>
              {inspection.durable_logs.capture_error &&
                <p role="alert">Output capture failed: {inspection.durable_logs.capture_error}</p>}
              {(inspection.durable_logs.truncated || inspection.durable_logs.retention_overflow) &&
                <p>Earlier output is outside the retained tail.</p>}
              {inspection.durable_logs.segment_gap && <p role="alert">A gap was detected in the recorded output.</p>}
            </> : <>
              <p>Recorded output unavailable: {inspection.durable_logs?.capture_error ?? inspection.durable_logs?.reason ?? 'unknown reason'}</p>
              {inspection.logs.available ? <><h3>Live recent output</h3><pre>{serviceOutput(inspection.logs) || 'No output yet'}</pre>
                {inspection.logs.truncated && <p>Earlier output is outside the retained tail.</p>}</>
                : <p>Output unavailable: {inspection.logs.reason ?? 'unknown reason'}</p>}
            </>}
          </>}
        </div>}
      </article>
    })}
    {inventory && <details className="service-listeners"><summary>Other local TCP listeners ({inventory.listeners.filter((item) => item.ownership === 'unknown').length}) · {inventory.coverage} coverage</summary>
      <p>Workspace ownership is unknown for these listeners.</p>
      <ul>{inventory.listeners.filter((item) => item.ownership === 'unknown').map((item) =>
        <li key={`${item.pid}:${item.address}:${item.port}`}>{item.address}:{item.port} · PID {item.pid}</li>)}</ul>
    </details>}
  </section>
}
