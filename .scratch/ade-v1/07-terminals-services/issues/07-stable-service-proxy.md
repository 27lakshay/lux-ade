# Stable local service proxy (F088)

Status: in progress
Type: implementation ticket

## Contract

`service.proxy.ensure` assigns one runtime-owned loopback HTTP URL to a managed
service's workspace/name/port variable. The runtime persists the route and keeps
its listener through an application-daemon handoff. A fresh runtime rebinds the
same port; failure to reclaim it blocks startup instead of returning another URL.
The route pins the durable service incarnation and its configured target port.
Removing and recreating the same name, or changing its target port, returns 503
until `service.proxy.remap` explicitly changes that pin while retaining the URL.
Remapping requires the expected current service identity and target port from
`service.list`, plus the expected previously pinned identity and target port from
`service.proxy.inspect`. These four compare-and-set fields prevent a delayed
remap from targeting a later replacement or a changed port.
`service.proxy.retire` releases a route and its listening port. It requires the
route key (`workspace_id`, `name`, `port_variable`) and four compare-and-set
fields from `service.proxy.inspect`: `expected_route_id`,
`expected_service_identity`, `expected_target_port`, and `expected_proxy_port`.
The runtime persists route deletion before closing and joining its listener.
The route ID is durable and unique to each creation, so a delayed retire cannot
delete a newly created route even if the OS reuses the same port. Existing
accepted HTTP and WebSocket connections may drain on their original upstream;
new connections are refused after retire returns. A failed registry write keeps
the live route and listener and returns an error; if recovery of an uncertain
rename also fails, the error explicitly states that persistence is uncertain.
An admission gate rejects a TCP connection accepted before retirement if it
only sends its HTTP headers after the retire acknowledgement.
Older registries receive route IDs before their listeners start.
Each HTTP connection connects to a loopback candidate, then asks the current
daemon for a fresh, family-specific listener and run-identity proof before it
forwards any request bytes. An unavailable daemon, stopped
service, changed transfer or contested listener returns HTTP 503. The proxy
requires the exact loopback `Host` header and accepts only origin-form HTTP/1.1
requests. Browser requests with an `Origin` must use that same loopback origin.
It relays request paths, bodies, WebSocket upgrades and subsequent bytes
without sending HTTP traffic to ADE's Unix-socket command API. The listener binds
only `127.0.0.1`. There is no positive listener cache. At most four fresh OS
probes run concurrently to bound `lsof` work without serializing an entire page
of assets. Request headers have a total five-second read
deadline; request bodies and chunk trailers have total time and size limits.

## Acceptance

- Through a real daemon and runtime, configure a service, ensure its URL, send a
  POST with path, query and body, then send and receive WebSocket bytes.
- The URL remains unchanged after the service stops and starts. When it is
  stopped, the URL returns 503 instead of reaching any process that appears on
  its old port. An incorrect Host or cross-origin request returns 400. Removing
  and recreating the service with the same name remains unavailable until an
  explicit identity-and-port-fenced `service.proxy.remap`. A managed process
  that stays alive after closing its listener must not proxy to an unrelated
  replacement on the same assigned port.
- The runtime listener stays bound through a daemon handoff and returns 503
  while the daemon is absent. It serves the same target again after reconnect.
  A stopped runtime restores the persisted URL on restart if its port is free.
- Retiring a route closes its listener and frees its quota slot while accepted
  streams drain. A stale route ID or any changed pin rejects retirement. A
  retired route stays absent after daemon/runtime restart; a newly ensured route
  has a new route ID. More than 256 create/retire cycles are possible. Registry
  persistence failure leaves the route reachable and inspectable.

Focused evidence: `pnpm exec playwright test e2e/specs/service-proxy.spec.ts
--reporter=list` passed 2/2 after `pnpm build:backend` on the current working
tree. The test uses real ADE daemon/runtime processes and a managed Node HTTP and
WebSocket service. Its 100 concurrent GET requests to distinct asset paths took
1294 ms wall time with fresh connect-time proof and four-probe concurrency,
with 0 unavailable responses, on an Apple M4,
macOS 26.6.1, Node 24.19.0. Four clients that send header bytes every 750 ms
each received HTTP 400 within seven seconds. This is one local
measurement, not a cross-machine performance claim or full F088 acceptance.
The integrated 64/64 source suite served 100/100 asset requests in 1408 ms
on the same host. The CLI exposes URL creation, inspection and explicit remap;
the hidden Electron E2E opens the stable URL in the embedded preview and
remaps a replaced service through the UI. Backend commit `abf03a3` and
CLI/Electron commit `207ec62` contain this slice.
The second E2E starts a real profile and services, converts its stopped SQLite
database to v9 shape by removing the new identity field and schema marker, then
restarts the daemon. It verifies distinct identities are backfilled, retained
through service edit and another restart, and used by the stable route. This
models the v9 schema; it does not execute an older ADE binary.

Retirement E2E runs through the same real daemon/runtime and managed HTTP and
WebSocket service. It verifies a WebSocket remains usable after retire while
the old listener closes, stale route-ID retirement fails after recreation,
daemon/runtime handoff does not resurrect a retired route, a forced registry
rename failure retains the original live route, and 257 consecutive
create/retire cycles release route slots. It also verifies that an accepted
idle socket cannot forward a delayed request after the retire acknowledgement.
The migration E2E removes `route_id` from a stopped registry and verifies
backfill on restart. After the admission gate and migration assertion,
`pnpm build:backend` and the focused proxy E2E passed 2/2 in 21.0 seconds.

## Remaining F088 work

This is a local/private slice. It does not provide an authenticated remote or
public alias; D09 requires a separate exposure policy. No same-user adversary
boundary is claimed. A runtime restart has a rebind gap; another process that
steals the port prevents ADE startup rather than allowing a hidden remap. The
target is currently a directly owned, observed IPv4 or IPv6 loopback TCP listener.
An absolute guarantee against a process swapping that listener after the final
OS proof but before the first forwarded byte requires inherited sockets or a
stronger connected-socket owner proof and remains open. The E2E confirms the
common close-and-rebind takeover fails closed.
Broader URL discovery remains before closing F088. The runtime's persisted proxy registry is
profile local; recovery from corruption and a rebind failure needs a dedicated
recovery surface before full F088 acceptance.
