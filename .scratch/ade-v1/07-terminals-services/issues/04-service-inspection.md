# Managed service status and output tail

Status: in-progress
Type: implementation ticket
Requirements: F086 (partial), F085
Blocked by: 02-local-managed-services, 03-listener-discovery

Outcome: A read-only `service.inspect` public daemon operation returns one configured service's execution state, observed TCP-listener readiness evidence, and a bounded tail of its PTY output. The response distinguishes a live listener from application readiness and from a port assignment.

E2E acceptance: In a real daemon/runtime, inspect an unstarted service with an assigned port and see no claimed readiness. Start a real HTTP service that emits a marker and binds its assigned port; inspect until execution is running, listener evidence is present, and the marker appears in bounded output. Stop it; inspect shows stopped and retains bounded last-run output when available. Start a service that never binds its assigned port and verify the operation does not call it ready. Force more output than the requested tail and verify truncation and offsets are explicit. Unknown service and invalid tail limits fail through the public protocol.

Contract and limits: `service.inspect` accepts `workspace_id`, `name`, and optional `tail_bytes` (default 8192, maximum 32768). The `readiness` result is TCP listener observation for the direct managed process only; it does not perform HTTP health checks or attribute child/reparented listeners. `logs` is a PTY byte tail encoded as base64, not structured or persistent log storage. It inherits the runtime's 256 KiB recovery ring, so old bytes and logs after runtime loss are unavailable. This slice has no Electron UI and does not complete F086.

Evidence (26 September 2026): A real-daemon E2E observes a configured but stopped service, a running Node HTTP service with a direct-process listener and a 50 KiB PTY output burst, a running process that never binds its assigned port, and retained output after stop. The bounded tail reports byte offsets and truncation. Invalid service identity and tail limits fail. Backend build and Rust formatting checks pass. Application-level health, persistent logs and UI remain open.

Failure-path evidence: A second real-daemon E2E kills only its isolated runtime supervisor. `service.inspect` still returns the configured service with unavailable execution, unknown readiness and unavailable output. Inspection re-reads the durable service identity after listener and output observations; a concurrent stop, restart or reconfiguration yields an explicit unknown result instead of combining an old owner with a new listener.
