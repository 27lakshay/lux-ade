# Audit minor fixes: plugins and providers

Three audit findings, each traced in the code before fixing. All three were real.
`pnpm check:static` passed (rustfmt, contract check, architecture, API parity,
typecheck, Fallow, builds, Clippy, 711 legacy Rust tests).

## 1. `Hosts::stop` retired a newer generation's host

- **Confirmed.** `Core::disable` reads `through` under the registry lock, releases
  it, then calls `hosts.stop`. `stop` waits for the slot lock, which `start()`
  holds for up to 15 s of activation. A concurrent enable and invocation can adopt
  and start generation N+1 first. `stop` then called `retire(state)` without
  checking the generation, and deactivated and killed the N+1 host.
- **Fix.** `stop` now calls the new `fence(guard, through)` in
  `crates/ade-daemon/src/plugins/host.rs`. `fence` raises `retired_through` and
  retires the running process only when `supervision.generation <= through`.
- **Test.** `plugins::host::tests::stopping_through_an_older_generation_spares_a_newer_host`
  starts generation 2, fences through 1 (still running), then through 2 (stopped).

## 2. `plugin.host.restart` answered `not_applied` after stopping the host

- **Confirmed.** `Hosts::restart` retires, deactivates and kills the running host
  before it starts the new attempt. A failed start came back as a `String`, and
  `host_restart` mapped every error to `not_applied`.
- **Fix.** `Hosts::restart` returns `RestartError`. `NotApplied` is kept for a
  refusal from `adopt`, before any host is touched. Any error after that is
  `Failed`; its message says so when a running host was stopped first.
  `host_restart` maps `Failed` to error code `failed`. The
  `PluginHostRestartRequest` doc comment names both codes; the contract was
  regenerated (doc text only; no shape change).
- **Test.** `plugins::host::tests::restart_reports_a_failed_start_as_failed`. A
  start from a missing artifact directory fails without spawning a process and
  yields `Failed`. A stale generation yields `NotApplied`.

## 3. Uninstall removed artifacts a draining host ran from

- **Confirmed.** `commit_uninstall` checked `enabled`, `live` and provider leases,
  but not `hosts.draining`. `uninstall` then removed `artifacts/<id>` under a
  superseded host that was still draining.
- **Fix.** `commit_uninstall` asks the new pure `dev::uninstall_refusal(id,
  leases, draining)`. The uninstall is refused with `conflict` while provider
  leases or draining hosts remain. A disabled plugin gains no new drain, so the
  check cannot go stale before the directory is removed.
- **Test.** `plugins::dev::tests::uninstall_waits_for_leases_and_draining_hosts`.
