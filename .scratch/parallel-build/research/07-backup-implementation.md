# Which backup implementation ships?

Ticket: [07-backup-implementation](../issues/07-backup-implementation.md).
Researched 2026-09-27 against `codex/architecture-proposal` at `aae7cf3`
(worktree `claude-parallel-build`). Research only; no code changed.

## Recommendation

- **Rust `ade-control backup` survives.** Its source is
  `crates/ade-daemon/src/bin/control/backup.rs`. It is the only backup the
  packaged app ships. The packaged E2E asserts that the app has no Python
  file and no `/usr/bin/python3` reference.
- **`scripts/managed_backup.py` is retired**, together with the backup
  actions in `scripts/profiles.py`, which imports it. Retire them only after
  their 19 E2E cases run against `ade-control` and pass.
- **The Rust tool is not ready to take over yet.** It lacks five behaviours
  that the Python-backed E2Es prove:
  - backup-during-writes pause hooks
  - checks that attachment BLOBs are complete
  - a guard that keeps the backup destination outside the source
  - a supported range of restore schemas
  - interrupted lifecycle-operation recovery fields

  Port those behaviours first, then switch the specs. Delete the Python file last.
- **Neither tool is a complete F050/R014 backup.** Browser tabs and cookies,
  and pending sends, live in separate Electron TypeScript bundles
  (`apps/desktop/src/main/browser.ts`, `apps/desktop/src/main/send-journal.ts`).
  No UI, CLI command or daemon RPC starts any backup today. Only E2E specs and
  `ade-control` run it.

## What is uncertain or skipped

- **Supported restore range (a decision).** Python restores `sessions.sqlite`
  schemas 12–16. Rust accepts only exactly 16, and exactly 3 for lifecycle.
  D15 requires "supported restore versions" to be declared. One E2E
  (`schema-12 restore cannot rebind…`) needs Rust to accept schema 12. See the
  options table below.
- **Bundle format compatibility.** Python writes format 1; Rust writes and
  reads only format 2. Neither reads the other. I found no evidence that a
  user holds Python bundles. The Python helper shipped in the package only from
  `5afc3eb` to `ccb0bad`, about ten hours on 2026-09-26. I recommend declaring
  format 1 unsupported rather than writing an importer. Confirm that no real
  profile holds a format-1 bundle you care about.
- **Lifecycle recovery fields.** Rust omits `recovery` and `finished_at` when it
  marks a running lifecycle operation `interrupted`. I did not check whether
  the daemon or the UI reads those fields.
- **Policy reading.** I treated the Python-backed specs in `e2e/specs/` as
  current E2E coverage whose tool invocation may change. I did not treat them
  as "prototype tests" that must stay frozen. The frozen prototype tests are
  `scripts/test_*.py`. None of them calls `managed_backup.py`.
- **Not run.** I read code and history only. I did not run any E2E, build the
  package or time anything.
- **Python for fixtures.** Many specs also use `python3 -c` to edit SQLite
  fixtures. That is test tooling, not a product dependency. It is out of scope
  here.

## Capability comparison

| Aspect | `scripts/managed_backup.py` (+ `profiles.py` backup actions) | `ade-control backup` / `ade-control profiles …-backend` |
|---|---|---|
| Databases | `sessions.sqlite` (schemas 1–16 to create; 12–16 to restore), `sessions.review.sqlite3` (0), `sessions.worktrees/lifecycle.sqlite3` (1–3) | Same three files; exact schema 16 / 0 / 3 only |
| Attachment BLOBs (stored in `sessions.sqlite`) | Copied; `database_check` verifies each live payload size, discarded rows empty, and a generation for schema ≥ 11 | Copied; **no attachment integrity check** |
| Non-SQLite manifests | `sessions.worktrees/empty.toml`; stable-read retry refuses a file changing mid-copy; strict JSON (duplicate keys rejected) | Same file; plain `fs::copy`, no stability or duplicate-key check |
| Browser tabs/cookies | Excluded (declared) | Excluded (declared) |
| Pending sends | Excluded; restore sets `send_intents.restore_hold=1` | Excluded; same `restore_hold=1` |
| Provider credentials | Excluded; restore creates empty private homes, resets accounts to `unverified` | Same |
| Execution fence on restore | `restore_fence`, `needs_rebind` on repositories/workspaces, `owned` cleared, running lifecycle ops → `interrupted` with `code`, `recovery`, `finished_at` | Same, but no `recovery` or `finished_at` |
| Online backup during writes | SQLite online backup, 128 pages/step; E2E pause hook `ADE_E2E_BACKUP_PAUSE_SIGNAL/RELEASE` | SQLite online backup, 128 pages/step, 30 s deadline; **no pause hook** |
| Backend manifest | `format_version: 1`, `scope`, `consistency`, `entries` (sha256, size, schema), `excluded` (8 items), `limitations` (3) | `format_version: 2`, `scope`, `entries`, `excluded` (4 items); no `consistency` or `limitations` |
| Registered profile bundle | format 1, `profile-backend-only`; records source runtime home, data dir, backend scope, full exclusions; checks runtime binding unchanged; **refuses a destination inside the source profile or data dir** | format 2, `profile-backend-only`; source id, name, private workspace and backend hash; holds `launch.lock`; **no destination-inside-source guard** |
| Registry / runtime binding it targets | Registry format 1, `runtime.json` format 1 | Registry format 2 (`profiles-v2`), `runtime.json` format 2. This is what Electron and the CLI use. |
| Registry-last restore, `pending-restores`, `resume-restore` | Yes | Yes (ported), plus an E2E publish-pause hook |
| Restore compatibility | Reads format 1 only; rejects schema < 12 with a named message | Reads format 2 only; rejects any schema ≠ current |
| Output envelope | `{"type":"managed_backup","operation":…}` | `{"type":"backup"}` / `{"type":"restored"}` |
| Ships in packaged app | No; removed in `ccb0bad` | Yes: `Contents/MacOS/ade-control` |

## Who calls each

No product code calls either tool for backup. `apps/desktop` and `apps/cli`
reach `ade-control` only for `profiles`, `runtime`, `locate` and
`browser-lease`.

**Python `managed_backup.py`**, directly or through `profiles.py`: 19 E2E cases.

| Spec | Cases | How |
|---|---|---|
| `e2e/specs/managed-backup-core.spec.ts` | 1 | Backup while drafts are written. Checks restored public reads, account reset, route and worktree exclusion, occupied destination, and corrupt-format, schema-11 and schema-99 rejection without target mutation. |
| `e2e/specs/attachment-retention.spec.ts` | 2 | v10 attachment upgrade after restore; snapshot paused mid-copy while reclaim runs |
| `e2e/specs/restored-send-hold.spec.ts` | 1 | Inherited send stays held |
| `e2e/specs/restored-workspace-fence.spec.ts` | 2 | External workspace and lifecycle-only fences |
| `e2e/specs/restored-workspace-rebind.spec.ts` | 8 (9 runs) | Rebind flows, including a doctored **schema-12** restore and two daemon-exit failpoints |
| `e2e/specs/local-profiles.spec.ts` | 1 | `profiles.py backup-backend`: no-binding refusal, **nested-destination refusal**, exclusions, occupied destination |
| `e2e/specs/profile-backend-restore.spec.ts` | 3 | `profiles.py restore-backend`: private workspace remap, fenced lifecycle, interrupted publish with symlink/corrupt-review refusal then resume |
| `scripts/profiles.py` | — | Imports `managed_backup` for its four backup actions |

**Rust `ade-control`**: 4 E2E cases.

| Spec | What |
|---|---|
| `e2e/specs/native-control.spec.ts` | Profile backup, `backup inspect` (format 2), restore, corrupt registered manifest rejected |
| `e2e/specs/desktop-restore-rebind.spec.ts` | Profile backup and restore, then Electron rebind UI |
| `e2e/specs/send-journal-transfer.spec.ts` | `backup create/restore` plus Electron pending-send transfer |
| `e2e/packaged/macos.spec.ts` | Installed backup; restore killed after publish; `pending-restores`/`resume-restore`; PATH has no system tools |

**Electron-only bundles**, neither Python nor Rust: `e2e/specs/browser-backup.spec.ts`
calls `captureBrowserProfile`/`restoreBrowserProfile`, and
`e2e/specs/send-journal-transfer.spec.ts` calls
`exportSendJournalProfile`/`importSendJournalProfile` through preload IPC.

## Can the packaged app run Python?

No, by design.

- `ccb0bad` "Replace installed Python controllers with Rust" removed
  `browser_lease.py`, `profiles.py`, `managed_backup.py` and `runtime.py` from
  `electron-builder.yml`. It added `target/release/ade-control` as
  `MacOS/ade-control`.
- It switched `apps/desktop/src/main/index.ts` and `browser.ts` from
  `/usr/bin/python3` to `ade-control`. `docs/build-and-release.md` now states
  "no installed Python requirement".
- `scripts/package-macos.mjs` builds all Rust `--bins` and stages no Python.
- `e2e/packaged/macos.spec.ts` asserts that `app.asar` contains neither
  `/usr/bin/python3` nor `profiles.py`, and that `Resources/` holds no `.py`
  file. It runs `ade-control` with `PATH=/no-system-tools` and points
  `ADE_PYTHON_BIN` at a missing file.
- On macOS, `/usr/bin/python3` is only a Command Line Tools stub. It is not
  guaranteed to exist, so reintroducing it would break R020.

## History since `e42e5e7`

The Rust code is newer and is a port of the Python code. Both files have since
been kept in step by hand.

| Date (2026) | Commit | Python | Rust |
|---|---|---|---|
| 09-26 13:00 | `5455362` | `managed_backup.py` created | — |
| 09-26 13:28 | `21b931b` | Attachment generation and tombstone checks | — |
| 09-26 13:40 | `5afc3eb` | `profiles.py backup-backend` | — |
| 09-26 14:21 | `22b9fd4` | Restore fence and send hold | — |
| 09-26 14:32 | `315dc8f` | Registry-last restore and resume | — |
| 09-26 15:15 | `6e3f0a5` | Rebind fields | — |
| 09-26 20:44 | `b4f1005` | Schema bump | — |
| 09-26 23:13 | `ccb0bad` | — | `backup.rs` and `main.rs` created (772 + 593 lines); formats bumped to 2 |
| 09-27 02:41 | `23ee13e` | — | `main.rs` only |
| 09-27 03:12 | `c5e341b` | Schema max 15 → 16 | Schema 15 → 16 |

`c5e341b` shows the cost of keeping both. Every daemon schema bump must edit
both files, and `progress.md` already records a failed full run caused by a
missed gate.

## Migration steps

1. **Decide the restore range.** See the options table below.
2. **Port the missing behaviours into `backup.rs`**, each proved by the spec
   named:
   - Attachment payload integrity checks, as in `database_check`.
     Proved by `managed-backup-core` and `attachment-retention`.
   - An online-backup pause hook for E2E, pausing mid-copy of `sessions.sqlite`.
     Proved by `attachment-retention` "snapshot remains valid while attachment
     reclaim runs".
   - A destination-outside-source guard in `profile_backup`.
     Proved by the nested-bundle case in `local-profiles`.
   - The "Restore requires a schema-12 backup" rejection, and the restore range
     from step 1. Proved by `managed-backup-core` and the `restored-workspace-rebind`
     schema-12 case.
   - The `recovery` and `finished_at` fields on interrupted lifecycle operations.
   - Optional hardening that no spec asserts today: the stable-read check for
     `empty.toml`, duplicate-key JSON rejection, and a declared `consistency`
     and `limitations` in the manifest (D15 asks for declared limits).
3. **Switch the 19 cases** from `python3 scripts/managed_backup.py …` to
   `ade-control backup …`, and from `python3 scripts/profiles.py … backup-backend|restore-backend|pending-restores|resume-restore`
   to `ade-control profiles …`. Assertions change in three ways:
   - The envelope `type` changes, from `managed_backup` to `backup` or
     `restored`.
   - `format_version` changes from 1 to 2.
   - The exclusion text changes. `managed-backup-core` matches
     "Stable service proxy routes", but Rust says "service routes". Align the
     assertion or the wording. `local-profiles` matches "Electron pending-send
     journal", but Rust's registered bundle has no `excluded` list, so add one.

   Keep every behavioural assertion.
4. **Port the non-backup parts** of `local-profiles.spec.ts` and
   `profile-backend-restore.spec.ts` that exercise `profiles.py` create, start
   and list with registry format 1. They belong to the `profiles.py` pair
   below. The backup cases can switch without them only if they create profiles
   with `ade-control` as well.
5. **Run the focused backup specs, then the full source and packaged suites.**
6. **Remove the backup actions from `scripts/profiles.py`, then delete
   `scripts/managed_backup.py`.** Update `docs/compatibility.md` and the
   schema-bump checklist in `progress.md` to name one backup gate.

Options for step 1:

| Option | Cost | Buys |
|---|---|---|
| A. Accept a declared range, schemas 12 to current, and let the daemon migrate forward after restore | A small range table in Rust; each schema bump must keep old-schema restore working | Keeps the schema-12 E2E; lets backups outlive one upgrade (R014 "recover after upgrade failure") |
| B. Exact current schema only (today's Rust) | Rewrite or retire the schema-12 rebind E2E; a backup is unusable after any schema bump | Simplest code |

I would pick **A**. R014's purpose is recovery after an upgrade failure. An
exact-match gate makes every backup unrestorable after the next migration.

## Other duplicated Python/Rust pairs

These are all controllers that `ccb0bad` ported to `ade-control`.

| Python | Rust (`ade-control`) | Remaining Python callers |
|---|---|---|
| `scripts/profiles.py` (registry v1) | `profiles` (registry v2, `profiles-v2`) | `local-profiles.spec.ts`, `profile-backend-restore.spec.ts`, `account-registry.spec.ts`. The v1 registry is no longer what the product reads. |
| `scripts/runtime.py` | `runtime status/restart/bind`, `locate` | `locate` in about 10 specs (`desktop-*`, `browser-*`, `local-profiles`); `adopt` in `local-profiles`. The GPUI tooling (`run.sh`, `package.py`, `test_recovery.py`, `test_bootstrap.py`) also uses it, so it cannot be deleted until the GPUI prototype is retired. |
| `scripts/browser_lease.py` | `browser-lease` | None found. It looks dead now and can be removed without migrating any E2E. |
| `scripts/managed_backup.py` | `backup create/inspect/restore` | This ticket |
