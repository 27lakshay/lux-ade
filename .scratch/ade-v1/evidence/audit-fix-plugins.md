# Audit fix: plugins

## Defect: host restarts re-activate with stale settings after `plugin.setting.set`

- Cause: `adopt` (`crates/ade-daemon/src/plugins/host.rs`) stored the incoming
  `LaunchSpec` only on a new generation or an empty slot. `Hosts::restart` and
  `ensure` passed a fresh spec for the same generation, and it was dropped, so
  `start` sent `activate` with the old settings. Crash restarts (`retry` then
  `start`) never call `adopt` and reused the old spec too.
- Fix:
  - `adopt` always stores the incoming spec for the current generation. A new
    generation still retires the old host and resets supervision; the same
    generation keeps supervision and the running process.
  - New pure `refresh(slot, spec)` replaces the stored spec only for the slot's
    current, unretired generation. It never creates a slot, changes supervision
    or touches a running host. `Hosts::refresh` wraps it.
  - `Core::setting_set` (`crates/ade-daemon/src/plugins.rs`) releases the plugin
    state lock, rebuilds the launch spec, and calls `Hosts::refresh`, so the next
    crash restart also activates with the new value. A running host keeps its
    activation until restarted, as before. No wire change.
- Tests (in-process, `plugins::host::tests`):
  - `adopting_the_same_generation_takes_its_new_settings`: generation 5 with
    foo=1, then foo=2 on the same generation; the stored spec has foo=2 and
    supervision (crash count) is kept.
  - `refreshing_updates_only_the_current_generation`: no slot is created; older,
    newer and retired generations are refused; the current one takes foo=2.
- Check: `pnpm check:static` passed.
