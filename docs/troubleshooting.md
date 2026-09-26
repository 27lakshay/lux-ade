# Troubleshooting lux-ade

The Electron app uses its bundled Rust controller for profiles, browser leases
and backend-only backup/restore. Provider CLIs and some provider runtimes remain
external; workspace scripts use their target project's installed toolchain.
An unsigned development bundle has not passed public-release Gatekeeper testing.
Use the checks below to identify a failure without deleting runtime data or
forcing another process to release its locks.

Run development commands from the repository root. For a packaged application,
replace `target/debug/ade-control` below with
`Lux ADE.app/Contents/MacOS/ade-control` and pass `--home` for the profile in
question.

## Inspect before changing state

```sh
target/debug/ade-control profiles list
target/debug/ade-control runtime status --home /path/to/profile/runtime
target/debug/ade-control locate --home /path/to/profile/runtime
```

`status` reports the daemon identity and endpoint; `locate` reports the endpoint
without connecting. `profiles list` reports the selected profile and its runtime
home. The Electron default registry is
`~/Library/Application Support/lux-ade/profiles-v2`.

| Symptom | Check and next action |
| --- | --- |
| `Pinned source or patch changed` / legacy source verification differs | Preserve the named dependency tree and its edits. Move it aside, then rerun `python3 scripts/bootstrap.py`. Do not stamp a modified directory as verified or discard edits. The patch ledger identifies the expected pins. |
| `Corrupt cached archive` | Preserve the reported file if diagnosing corruption, move that cache entry aside, and rerun bootstrap to fetch/check it again. Do not bypass the checksum. |
| Missing Ghostty archive/resources or Metal compiler | Install the documented Xcode/Metal prerequisites, check `xcode-select -p`, then run bootstrap. Verify deliberate `ADE_ZIG_BIN`, `GHOSTTY_KIT_DIR` and `GHOSTTY_RESOURCES_DIR` overrides. lux-ade does not change Xcode selection. |
| `cargo-nextest` not found | Run `python3 scripts/install_tools.py`, then `bash scripts/check.sh`. The check script adds project-local tools to PATH. |
| App fails only when launched from Finder | Finder's environment can differ from the shell. Check the runtime prerequisite table in build-and-release.md. Project scripts use matching installed tools found outside the shell startup files; provider Node/Bun overrides are explicit. |
| Daemon exits or does not become ready | Inspect the reported profile's `daemon.log` and structured `logs/`. Confirm the selected daemon/resources match the intended build. Preserve the profile when investigating a migration failure. |
| Another daemon claims the endpoint / writer or runtime lock stays held | Inspect `status`, the reported endpoint and profile. Wait for the existing lifecycle operation or close it through lux-ade's supported lifecycle. Do not remove lock files or replace a PID blindly. |
| Compatible daemon remains on an older build | This is intentional. `ade-control runtime restart --home /path/to/profile/runtime` requests a fenced daemon replacement while preserving a compatible supervisor. Run only when ready to apply the change. |
| Supervisor protocol is incompatible | Use a matching complete build. A deliberate `replace-supervisor --stop-active` ends current shells and providers; it is not a transparent recovery operation. Inspect status before choosing it. |
| Provider process cannot start | Check provider executable/runtime availability and configured `ADE_NODE_BIN`, `ADE_BUN_BIN`, `ADE_CLAUDE_BIN`, `ADE_CODEX_BIN`, `ADE_OPENCODE_BIN` or `ADE_OMP_BIN` as applicable. Use the credential-free demo to distinguish app behavior from provider installation/authentication. |
| Draft restore fails | Use **Retry loading draft**. Do not treat the failed read as an empty conversation or overwrite a retained draft. |
| Window close cannot save | Use **Retry save and close** or **Keep working**. The window remains open so unsaved drafts/layout remain available. |
| Newer database schema is refused | Run a build compatible with that schema. Do not decrement `user_version`, delete tables, or assume an executable rollback also rolls back data. |
| Release packaging reports missing/incomplete symbols | Rebuild with the repository release profile and retain its object files/dSYMs. Package again; do not bypass UUID checks or strip the only symbol-bearing copy. |
| Offline Rust notice resolution fails | Use the Rust/Cargo environment that built the app, with its source cache available. Packaging deliberately uses `--locked --offline`; do not fabricate missing notices or silently change the lockfile. |
| Notice inventory reports missing evidence | Read the relevant Rust/provider/native inventory. This is distribution work, not a runtime failure. A declared SPDX expression is not proof that required texts were retained. |

## Export diagnostics deliberately

The daemon executable supports a read-only export without starting its server:

```sh
target/release/ade-daemon --export-diagnostics /tmp/ade-diagnostics
```

Use the correct `ADE_LOG_DIR`, `ADE_DATA_DIR` or `ADE_RUNTIME_HOME` for the profile
being investigated. Inspect the output before sharing it. Preserve the packaged
build manifest and matching dSYM UUIDs with a crash report. Export does not upload
anything automatically.

## Reproduce without credentials

Follow [the local demo](demo.md) for a fake conversation, approvals and failure
states. `ADE_UI_SHOWCASE=1 target/debug/ade-client` opens shared components without
a provider. Substitute your `CARGO_TARGET_DIR` when configured.

See [build and release](build-and-release.md), [compatibility](compatibility.md)
and [task lifetimes](task-lifetimes.md) for the underlying contracts. Local daemon
replacement is not an app updater and offers no automatic database rollback.
