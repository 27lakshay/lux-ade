# ADE v1 delivery record

Updated: 2026-09-26. Branch: `codex/architecture-proposal`. No Git remote is
configured. This is a checkpoint, not a claim that the v1 register is complete.

## Integrated checkpoints

| Commit | Slice | Evidence |
|---|---|---|
| `cada60a` | Architecture and v1 specs | 140-item register and domain acceptance recorded |
| `73896a9` | pnpm/Electron workspace | Running-app smoke |
| `da1e5b9` | Isolated daemon harness | Public protocol lifecycle E2E |
| `e1346cf` | Desktop daemon attachment | Renderer reload E2E; HMR manually kept daemon boot and shell PID |
| `16b697b` | Bounded xterm replay | Real PTY output/resize and overflow E2E |
| `252af3a` | Root provider lockfile | Frozen install, provider fixture suite, GPUI build-only packaging |
| `3dc2643` | xterm terminal surface | Electron terminal input/reload/alternate-screen E2E |
| `b2e9eac` | Local CLI and shared client | CLI/Electron shared terminal and endpoint-error E2E |
| `ccfc06b` | Electron conversation slice | Create/send/structured transcript/reload/approval E2E |
| `4678d37` | Native question form | Codex structured answer E2E |
| `f11e28a` | Local profile launcher | Two-profile isolation/restart and incompatible-owner E2E |
| `60fa747` | Electron profile selection | Two-daemon UI switch and catalog isolation E2E |
| pending | Open local folder | Stable workspace selection and terminal E2E |

Latest full check: `pnpm check` passed typecheck, Fallow, backend build,
desktop/CLI build, and 13/13 running-process E2E tests. Existing provider
fixture suite passed after root lockfile migration. The old GPUI app built and
packaged successfully in build-only mode; its GUI startup was not verified.

Separate opt-in live check on this Mac: Codex CLI 0.153.4 reached `ready` and
returned the expected answer in 5.9 seconds; Claude Code 2.1.282 did so in
2.86 seconds. Oh My Pi reached `error` after 2.85 seconds. This Mac has no
`~/.pi/agent/auth.json` and no common provider API key in the environment;
the failure may have another cause and needs a configured-account rerun.
The repeatable command is `pnpm test:e2e:live codex claude omp`.

The 11 E2E cases are narrow slices. No entire v1 domain or 140-item requirement
register is marked complete by this record.

## Active and next work

- Electron profile creation/switching works in local development. The profile
  launcher requires `scripts/profiles.py`; packaging it for a distributable app remains.
- Workspace opening works for local folders; repository and worktree lifecycle
  acceptance remains.
- Draft recovery, conversation pagination, native attachments/context, queues,
  broader approval forms, and live Oh My Pi verification remain.
- Account management, extensible providers/plugins, worktrees, dev services,
  browsers, notifications, remote hosts, unified catalogs/history, customization,
  operations and reliability acceptance remain in the v1 register.
- Existing packaged provider tree is about 2.0 GB. Release size needs work.
- Deterministic provider fixtures are evidence for protocol behavior. They do
  not establish live-account compatibility or quality.

See each domain `issues/` ticket for slice-specific acceptance and limits.
