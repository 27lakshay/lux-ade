# Observed local TCP listeners

Status: in-progress
Type: implementation ticket
Requirements: F085, F087
Blocked by: 02-local-managed-services

Outcome: A read-only `listener.list` daemon operation reports observed local TCP listeners and each managed service's assigned port separately. A listener is attributed to a workspace and service only when its PID matches the active runtime's direct service process with the same transfer identity. Other listeners have unknown workspace ownership.

E2E acceptance: Start a real managed HTTP service and an unrelated local listener. Query the public protocol to observe both. The managed listener carries its workspace/service identity; the unrelated listener remains unknown. An unstarted service has an assigned port but no verified listener. If another process binds an assigned port before service start, the daemon must not attribute that listener to the service. After service stop, the assignment remains but the listener is no longer claimed.

Limits: The first backend implementation is macOS local-host observation through the installed `lsof` field interface. It does not prove complete host visibility, attribute child or reparented processes, provide a stable cross-host identity, or implement the frontend. Full F085 acceptance remains open.

Evidence (26 September 2026): A real-daemon public-protocol E2E observes a managed Node HTTP listener and an unrelated listener. It verifies a configured but unstarted port is `unobserved`, a stolen assigned port is `observed_other` and blocks service start, and only the direct managed process is attributed to a workspace/service. The listener is no longer claimed after stop. `listener.list` returns `scope: local_host`, `coverage: partial`, observed TCP listeners and separate assigned-port observations. A missing observation is not proof that no listener exists.

The Electron Services pane now exposes assigned-port observations and lists
other observed local TCP listeners as unknown workspace ownership with partial
coverage. Listener observation failure does not hide configured services; the
app shows it as unavailable. The desktop service E2E creates an unrelated real
listener and verifies it appears without a workspace claim.
