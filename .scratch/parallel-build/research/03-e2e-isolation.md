# E2E isolation: what collides when two worktrees run `pnpm check`

Ticket: [03 — E2E isolation](../issues/03-e2e-isolation.md)
Date: 2026-09-27
Code read: worktree `claude-parallel-build`, branch `codex/architecture-proposal` at `aae7cf3`.
Nothing was built or run; every finding comes from reading the code and measuring disk.

## Answer

Two worktrees can run `pnpm check` at the same time today. No hard collision
blocks it.

- Each E2E creates its own `mkdtemp` directory. Daemon, runtime, profile and
  Electron paths all derive from that directory, so they do not overlap.
- Nothing takes an Electron single-instance lock. Nothing registers with launchd.
- Cargo `target/`, `node_modules`, Fallow's cache, Playwright's `test-results/`
  and the packaged app all live inside each worktree.

Three things still need a small change or a rule:

1. **One spec touches the real profile registry.** `desktop-smoke.spec.ts` starts
   Electron without `ADE_SOCKET` or `ADE_PROFILES_HOME`. Electron therefore reads
   the real `~/Library/Application Support/lux-ade/profiles-v2` and takes its
   `registry.lock`. It works only because that registry is empty.
2. **Specs inherit the caller's `ADE_*` environment.** A worker shell that exports
   `ADE_SOCKET`, `ADE_PROFILES_HOME` or `ADE_RUNTIME_HOME` leaks the value into
   every spec that spreads `process.env`.
3. **A new worktree cannot build the backend without gitignored inputs.**
   `.ade/native` and `.ade/vendor` must exist before `pnpm build:backend` runs.

The remaining risk is load, not shared state. Two suites plus two Cargo builds
on 10 cores and 24 GB may push 30-second test timeouts. That is unmeasured;
[ticket 12](../issues/12-worker-capacity.md) should measure it.

Keep `target/` per worktree. A shared `CARGO_TARGET_DIR` would create a real
collision; see row 2 of the table.

## Collision table

| # | Resource | Collides today? | Evidence (file:line) | Smallest fix | Risk |
|---|---|---|---|---|---|
| 1 | Real profile registry `~/Library/Application Support/lux-ade/profiles-v2` | Yes, mildly. Both suites open it and take a blocking `flock` on `registry.lock`. If a real profile ever exists there, both suites would start that profile's daemon on one shared socket. The directory already exists on this Mac and holds only `registry.lock`. | `e2e/specs/desktop-smoke.spec.ts:13-19` (no `ADE_SOCKET`, no `ADE_PROFILES_HOME`); `apps/desktop/src/main/index.ts:17-18` (no socket means managed profiles); `index.ts:1589-1592` (startup calls `refreshProfiles`); `crates/ade-daemon/src/bin/control/main.rs:361-365` (default home), `:383` (blocking registry lock), `:153-170` (socket `/tmp/ade-<uid>-<sha(home)>.sock`) | Set `ADE_PROFILES_HOME: join(userData, 'profiles')` in the smoke spec's `env`. This is one line in an E2E spec. | Low today. Medium once the user creates a real profile. It also leaks test state into the user's real app. |
| 2 | Cargo `target/` | No. There is no `.cargo/config.toml` and no `CARGO_TARGET_DIR`, so each worktree builds its own `target/`. The trap is sharing it: Cargo's build lock would serialize both builds, and one worktree's build would replace binaries the other worktree's E2Es are running. Tests and Electron also resolve binaries relative to the worktree. | `package.json` `build:backend`; `scripts/cargo.mjs:6-11` (passes the environment through); `e2e/fixtures/daemon.ts:150` (`resolve('target/debug/ade-daemon')`); `apps/desktop/src/main/index.ts:590-595` (`../../target/debug/...`) | Keep `target/` per worktree. Never export a shared `CARGO_TARGET_DIR` to workers. | None as long as the rule holds. |
| 3 | Shared Cargo and pnpm caches (`~/.cargo/registry`, pnpm store at `~/Library/pnpm/store`) | Briefly. Cargo holds a package-cache lock while it resolves, and `--locked` with a warm cache makes that short. pnpm's store is safe to use concurrently. | `package.json` `build:backend` (`--locked`) | None. | Low. |
| 4 | Default daemon socket `/tmp/lux-ade-v4-<uid>.sock` | No. E2Es never use it, because the fixture always sets `ADE_SOCKET` inside a `mkdtemp` root. | `crates/ade-daemon/src/bin/daemon/bootstrap.rs:50-54`; `e2e/fixtures/daemon.ts:144-159` | None. Row 6 covers inherited values. | Low. |
| 5 | Runtime and managed-profile sockets in `/tmp` | No. The runtime socket is `ADE_RUNTIME_SOCKET` (set by the fixture) or a hash of the data directory. The managed-profile socket is a SHA of the profile home. Both derive from unique temp paths. | `crates/ade-runtime/src/runtime.rs:49-62`; `control/main.rs:153-170`; `daemon.ts:148,159` | None. | Low. |
| 6 | Inherited `ADE_*` environment | Only if the caller exports one. Specs spread `process.env` first. `daemon.ts` overrides `ADE_DATA_DIR`, `ADE_SOCKET`, `ADE_ROOT` and `ADE_RUNTIME_SOCKET`, but not `ADE_RUNTIME_HOME`. The daemon uses an inherited `ADE_RUNTIME_HOME` to name the browser profile. The smoke spec would also pick up an inherited `ADE_SOCKET`. | `daemon.ts:152-160`; `crates/ade-daemon/src/bin/daemon/server.rs:57-70`; `desktop-smoke.spec.ts:16-19` | In `playwright.config.ts`, delete `ADE_SOCKET`, `ADE_PROFILES_HOME`, `ADE_RUNTIME_HOME`, `ADE_DATA_DIR`, `ADE_ROOT` and `ADE_DAEMON_BIN` from `process.env`. It already deletes `NO_COLOR` the same way. | Low. It matters when a worker runs inside an ADE-managed terminal. |
| 7 | Runtime home default `~/Library/Application Support/lux-ade/runtime` | No. The daemon and runtime use it only for logs, and only when `ADE_DATA_DIR` is unset. Fixtures always set `ADE_DATA_DIR`. `ade-control` sets `ADE_RUNTIME_HOME` per profile. | `crates/ade-platform/src/resources.rs:28-48`; `control/main.rs:305-310`; `scripts/runtime.py:26` (Python tooling only) | None. | Low. |
| 8 | Electron user data and single instance | No. All 34 Electron specs set `ADE_E2E_USER_DATA_DIR` to a temp directory. No code calls `requestSingleInstanceLock`. Windows stay hidden under the `accessory` activation policy, so the suites do not compete for focus. | `apps/desktop/src/main/index.ts:699-701`, `:1560-1563`; `playwright.config.ts:3`; a repo-wide grep finds no `requestSingleInstanceLock` | None. | Low. |
| 9 | Browser owner socket directory `/tmp/ade-browser-owner-<uid>` | Shared directory, but no collision. Each socket name contains a random UUID, and no code sweeps the directory. | `apps/desktop/src/main/browser-owner.ts:19-28` | None. | Low. |
| 10 | launchd, login items, URL schemes | None exist. A grep finds no `launchctl`, LaunchAgents, `SMAppService`, `setLoginItemSettings` or `setAsDefaultProtocolClient`. `ade-control` detaches daemons with `setsid`, not launchd. | `control/main.rs:325-333` | None. | None. |
| 11 | TCP ports | Rarely. Service ports come from a hashed window of 20000–39999. The daemon probes each port, then releases it, and the service binds it later; another suite can take the port in that gap. The service proxy binds port 0 and later rebinds its saved port, so a restart test fails if the other suite took that port. `listener.list` runs a host-wide `lsof`, but its spec uses `arrayContaining`, so the other suite's listeners do not break it. Port 65534 serves as an unreachable URL, but it sits inside macOS's ephemeral range (49152–65535). | `crates/ade-daemon/src/services.rs:56-66`, `:176-199`; `crates/ade-runtime/src/bin/supervisor/service_proxy.rs:106`, `:186`, `:388`, `:527-528`; `crates/ade-daemon/src/listeners.rs:29`; `e2e/specs/listener-discovery.spec.ts:22-40`; `e2e/specs/browser-profile-switch-race.spec.ts:18`; `e2e/packaged/macos.spec.ts:79` | None up front. If flakes show up, give each worktree a disjoint service-port window or retry the affected spec once. | Low. |
| 12 | Packaged app | Not part of `pnpm check`. Output goes to the worktree's `dist/electron/mac-arm64/Lux ADE.app`, and staging goes to the worktree's `.ade/package-stage`. Tests start the app through `executablePath`, not LaunchServices, so the shared `appId dev.lux.ade` does not matter. The electron-builder and Electron download caches in `~/Library/Caches` are shared. | `electron-builder.yml:1-6`; `scripts/package-macos.mjs:5-10`, `:108`; `e2e/packaged/macos.spec.ts:10`, `:45` | None. Nothing is installed to `/Applications`. | Low. Cache concurrency is unverified. |
| 13 | Gitignored build inputs in `.ade/` | Not a collision; a setup blocker. `build:backend` builds `ade-runtime` with `native-terminal`, which links `.ade/native/vt/lib/libghostty-vt.a` and includes headers from `.ade/vendor`. The workspace `Cargo.toml` also points a path dependency into `.ade/vendor`. A fresh worktree has none of these. This worktree has a 3.0 GB copy of `.ade`, of which only about 0.3 GB is needed. | `crates/ade-runtime/build.rs:8-19`; `Cargo.toml:16`; `.gitignore:1-2` | When creating a worktree, clone `.ade/native`, `.ade/vendor` and `.ade/tools` with `cp -c`, which costs almost no disk on APFS. Also run `pnpm install`. Skip `.ade/package-stage` and `.ade/package-deploy-probe`. | High if skipped: the backend build fails. |
| 14 | CPU, memory and PTYs | Unmeasured. Each E2E starts a daemon, a runtime and often Electron. Two suites double that load, and the Cargo builds overlap with it. The machine has 10 cores and 24 GB. The per-test timeout is 30 s. | `playwright.config.ts:10-11`; `sysctl hw.ncpu hw.memsize` | Serialize the build steps across worktrees, or allow at most two full suites at once until ticket 12 measures capacity. | Medium. This is the most likely source of flakes. |

## Current Playwright settings

| Config | `testDir` | `workers` | Timeout | Shard, `fullyParallel`, retries |
|---|---|---|---|---|
| `playwright.config.ts` (source, used by `pnpm check`) | `e2e/specs` (76 files) | 1 | 30 s | None set; the defaults apply (no shard, no parallelism within a file, 0 retries) |
| `playwright.package.config.ts` | `e2e/packaged` | 1 | 90 s | None |
| `playwright.live.config.ts` | `e2e/live` | 1 | 150 s | None |

CI (`.github/workflows/check.yml`) does not run `pnpm check` or Playwright, so
local runs are the only E2E signal.

## Full-suite timings from `.scratch/ade-v1/progress.md`

| Checkpoint (2026-09-26/27) | Source E2Es | Time |
|---|---|---|
| Bounded dependency correction | 178 + 1 skip | 5.8 min full source run |
| Real-provider fixture slice | 179 + 1 skip | 6.0 min |
| CLI worktree retry | 185 + 1 skip | 6.1 min source checks |
| CLI terminal lifecycle | 186 + 1 skip | 22 min "focused and full checks" |
| Browser owner reads (`7dc1c84`) | 189 + 1 skip, run twice | 13 min "source checks" for both runs |
| Earlier (152–173 E2Es) | — | 4.4–5.2 min |

One full serial source run takes about 6 minutes at 185–190 E2Es. A slice
typically runs it 2–3 times, which gives the 13–22 minute check budgets. The
progress log does not say whether those figures include `build:backend` and
`pnpm build`.

## Disk cost per worktree

Measured in the main checkout (`/Users/lakshyakumar/work/lux-ade`). The disk has
124 GiB free.

| Item | Size | Needed for `pnpm check`? |
|---|---|---|
| `target/debug` | 6.3 GB in the main checkout. That includes legacy GPUI `ade-client`, test and Clippy artifacts (82 `gpui` crates in `deps`). A backend-only debug build is estimated at 2–4 GB. | Yes |
| `target/release` | 0.4 GB | Packaging only |
| `node_modules` | 2.0 GB apparent. Most files are hard links or clones of the pnpm store. The Electron `dist` (307 MB) is materialized per install, and the main checkout has it twice. | Yes |
| `.ade/native` + `.ade/vendor` + `.ade/tools` | about 0.3 GB | Yes |
| `.ade/package-stage` + `.ade/package-deploy-probe` | about 2.6 GB | Packaging only |
| `dist/` | 20 GB in the main checkout, mostly accumulated symbols (13 GB) and old apps. One packaged app is under 1 GB. | Packaging only |

Estimate: about 3–5 GB of new disk per worktree for `pnpm check`, and about
3 GB more if that worktree also packages. A coordinator plus two workers
therefore needs roughly 10–15 GB beyond the main checkout.

## Uncertain or not checked

- I did not build or run anything. The backend-only `target/` size, the load
  effect on timeouts, and pnpm's actual clone-versus-copy behaviour are estimates.
- The progress log does not show whether its timings include the build steps.
- I did not check whether worktrunk (`ADE_WT_BIN`, used by one spec) writes
  global state outside the temp repositories it operates on.
- The electron-builder and Electron download caches in `~/Library/Caches` may not
  be safe when two packaging runs start together. Packaging is outside
  `pnpm check`.
- Raising `workers` above 1 inside one suite looks feasible, because every spec
  uses its own temp root. The same load risk as row 14 applies, as does row 1
  until the smoke spec is fixed. I did not audit every spec for cross-test
  ordering assumptions.
- Detached daemons and runtimes (`setsid`) survive an interrupted suite. They do
  not collide, because their paths are unique, but they keep using CPU and
  memory until someone stops them.
