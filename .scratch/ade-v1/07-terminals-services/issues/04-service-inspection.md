# Managed service inspection and HTTP health

Status: in-progress
Type: implementation ticket
Requirements: F086 (partial), F085
Blocked by: 02-local-managed-services, 03-listener-discovery

Outcome: A read-only `service.inspect` public daemon operation returns one configured service's execution state, observed TCP-listener readiness evidence, and a bounded tail of its PTY output. The response distinguishes a live listener from application readiness and from a port assignment.

E2E acceptance: In a real daemon/runtime, inspect an unstarted service with an assigned port and see no claimed readiness. Start a real HTTP service that emits a marker and binds its assigned port; inspect until execution is running, listener evidence is present, and the marker appears in bounded output. Stop it; inspect shows stopped and retains bounded last-run output when available. Start a service that never binds its assigned port and verify the operation does not call it ready. Force more output than the requested tail and verify truncation and offsets are explicit. Unknown service and invalid tail limits fail through the public protocol.

Contract and limits: `service.inspect` accepts `workspace_id`, `name`, and optional `tail_bytes` (default 8192, maximum 32768). The `readiness` result is TCP listener observation for the direct managed process only; it does not perform HTTP health checks or attribute child/reparented listeners. `logs` is a PTY byte tail encoded as base64, not structured or persistent log storage. It inherits the runtime's 256 KiB recovery ring, so old bytes and logs after runtime loss are unavailable. This slice has no Electron UI and does not complete F086.

Evidence (26 September 2026): A real-daemon E2E observes a configured but stopped service, a running Node HTTP service with a direct-process listener and a 50 KiB PTY output burst, a running process that never binds its assigned port, and retained output after stop. The bounded tail reports byte offsets and truncation. Invalid service identity and tail limits fail. Backend build and Rust formatting checks pass. Application-level health, persistent logs and UI remain open.

Failure-path evidence: A second real-daemon E2E kills only its isolated runtime supervisor. `service.inspect` still returns the configured service with unavailable execution, unknown readiness and unavailable output. Inspection re-reads the durable service identity after listener and output observations; a concurrent stop, restart or reconfiguration yields an explicit unknown result instead of combining an old owner with a new listener.

The Electron Services pane now requests `service.inspect` for an expanded
service, displays bounded recent output, names TCP listener evidence and keeps
application health explicitly unverified. It updates while open and after
start/stop without overlapping polls. A real Electron/daemon E2E sees the log
marker and TCP state through the UI before and after app closure. HTTP health
probes and persistent logs remain outside this slice.

An explicit `health_check` request now checks an assigned service port over
IPv4 loopback, with a selected path and 50–2000 ms HTTP probe deadline. Listener
observation adds latency outside that probe deadline. The request does
not follow redirects or contact arbitrary hosts. It returns the HTTP status,
timeout or error separately from TCP observation; missing or changed managed
listener evidence and stop/identity races return unknown. The Electron pane
offers an on-demand HTTP check and labels its result as the last check, so a
stale sample is not presented as a continuous health monitor. Real-daemon E2E
checks 200, 503, 302, timeout, invalid targets and a held request overlapping
service stop. The desktop E2E checks healthy and stopped results through the
running app. A persistent health policy, continuous monitoring, IPv6/remote
targets, durable structured logs and full F086 acceptance remain open.

Configured monitoring slice: Service recipes may opt in with
`config.health: {port_variable,path,timeout_ms,interval_ms}`. The port variable
must be one of that service's assigned ports. The HTTP deadline is 50–2000 ms;
the sampling interval is 250–60000 ms and must exceed the deadline. The daemon
serializes recurring samples in one worker and samples at most one due service
per 250 ms pass. Concurrent recurring/on-demand samples are capped at four.
The interval is a best-effort target; inspection and HTTP time can delay later
services. `health_monitor.schedule_delay_ms` reports delay past the configured
interval, and an overdue sample becomes `stale` with basis `sampling_delayed`
after two intervals. Attempts are timed even when a service has exited or a
probe fails, so one broken service cannot monopolize the worker.
`service.health.sample` requests an immediate sample without
changing the policy. The existing `service.inspect.health_check` remains a
separate one-shot check. `service.inspect.health_monitor` reports the most recent
sample with `sampled_at_ms` and `fresh_until_ms`, or explicit disabled, unknown,
stale or not-running state. Samples are memory-only: a daemon restart begins
unknown until new evidence arrives. Stop, service edits and replacement runs
invalidate old samples through service revision and runtime transfer identity.
The monitor also requires current running execution evidence before showing a
fresh sample. The check still uses only the assigned IPv4 loopback port and
verified direct-process listener; HTTP redirects are not followed.

Real-daemon E2E configures a policy, observes recurring 503 evidence, forces a
200 sample through the public command, stops and restarts the service, and
observes 503 from the successor without carrying forward its predecessor's
healthy result. A separate minimum-interval E2E leaves the first service exited
and verifies the second service receives successive healthy samples. The profile
accepts at most 512 configured health policies, and the scheduler reads only
active configured services; unrelated service definitions cannot disable it.
Persistent sample history, alerting and full F086 acceptance
remain open.

Durable output slice: `service.inspect.durable_logs` exposes a bounded base64
tail from runtime-owned service output files, separately from the existing PTY
`logs`. Each service retains at most two 512 KiB segments for its latest run;
each inspection returns at most 32 KiB. The response names the run transfer
identity, byte offsets, retained start, truncation, retention overflow and any
segment gap. `coverage: captured_bytes_only` does not promise complete output
when a write fails or the runtime dies; a known live writer error appears as
`capture_error`. Missing or unsafe files report unavailable. The service record
stores the last reserved transfer identity with a serde default, so old
records remain readable and a failed successor launch cannot show the prior
run's output. A newly reserved run returns unavailable until its own file
exists. Stop keeps its last output; a new run or service removal retires it.
The data directory and files must be owned by the runtime user, the private
log directory permits no group or other access, and file reads use no-follow
with type, link-count and size checks. Segment writes stay outside the runtime
terminal-state lock. The bound covers retained files per service, not every
service in a profile; runtime loss can delay deletion until recovery or manual
profile cleanup. Writes are visible across daemon and runtime process restart
but are not promised durable across machine power loss.

Real ADE-process E2E emits over 1 MiB, checks retained offsets and the final
marker, verifies output after stop, and confirms a failed successor cannot
expose the predecessor marker. A separate test confirms the same run output
survives daemon handoff and remains readable after the isolated runtime is
killed. Another test replaces the private log directory with a symlink and
checks that capture reports an error without writing to its target. Structured
logs, streaming APIs, full retention management and UI
remain outside this F086 slice.

Reader hardening: inspection opens segments without following symlinks or
blocking on a substituted FIFO, validates the opened file descriptor, and
limits each read to one byte beyond the maximum segment size. It checks size
again after reading, so a file that grows after the first check cannot cause
unbounded allocation. Real-daemon E2E replaces a stopped service's segment
with a FIFO and an oversized regular file and verifies both return an explicit
unavailable result. Offset arithmetic uses checked addition; the same E2E
changes a valid segment's start offset to `u64::MAX` and verifies inspection
returns unavailable instead of panicking or wrapping.
