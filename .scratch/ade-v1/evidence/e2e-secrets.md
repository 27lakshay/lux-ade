# E2E round 3: secret references (F089 at rest, F059 credentials)

## Blocker found during the run

The machine's `securityd` stopped answering part-way through the second
full run, about 13:32 IST on 2026-09-27. After that, every keychain call on the
machine hung, including a scratch-keychain `create-keychain` and the user's
own `security find-generic-password -s "Claude Code-credentials"` lookups
(two of them had hung for more than 9 minutes when this was written). The
cause is not proven. The timing matches this slice's E2E runs:

- The first run called `security find-generic-password -w` on items the
  daemon had created. Those items trust only the daemon, so `security` may
  have asked `SecurityAgent` to show an access prompt; a `SecurityAgent`
  process started then and exited later.
- The next run created a scratch keychain for every profile of four suites,
  two workers at a time, while nine other workers ran.

Changes made in response: specs no longer read daemon-made items with
`security` (they list accounts, which reads attributes only), and the scratch
keychain is opt-in (`test.use({ keychain: true })`) instead of created for
every profile. No system process was killed. Restoring `securityd` (logging
out, or restarting it) is the user's call.

## Outcome

| Area | Result |
|---|---|
| Service secrets at rest | Stored as credential references (`secret_refs`); values live in the Keychain or the daemon's environment |
| Plugin credentials (F059) | Typed references only; `{"secret": ...}` moves a value into the Keychain |
| Migration | Plain-text service secrets and free-text plugin credentials move into the Keychain when the profile opens |
| E2E harness | Scratch keychain fixture inside the scratch `HOME`; `ADE_KEYCHAIN` confines the daemon to it |

## Acceptance criteria

Architecture section 7: "Store secret references and redacted metadata rather
than raw credential-bearing launch environments." 07 F089: "show effective
nonsecret configuration". 04 F059: "Persist namespaced records/settings and
credential references".

| Criterion | Spec | Status |
|---|---|---|
| A sent service secret moves into a Keychain item; replies, CLI and every profile file hold no value; the process gets it | `secrets/services.spec.ts` › a secret sent as a value moves into the keychain… | pass (before the `securityd` failure) |
| Duplicate configure converges on the same item; a conflicting or running edit makes no orphan item | same | pass (before) |
| An ADE item cannot be copied to another secret | same | pass (before) |
| Rotation makes a new item and deletes the old; survives a daemon kill; remove deletes the item | same | pass (before) |
| `{env}` and user `{keychain}` references resolve only at launch, never cached | `secrets/services.spec.ts` › references resolve only at launch… | pass (before) |
| A reference that names nothing refuses the start before any reservation (no owner, terminal or run) | same | pass (before) |
| A pasted token as a variable name, and value plus reference, are refused; ADE never deletes a user item | same | pass (before) |
| Plain-text service secrets move into the Keychain on open; while the Keychain is unusable they are never shown or launched | `secrets/services.spec.ts` › a secret stored in plain text… | pass (before) |
| Plugin credential stored as a reference; `{secret}` converges; the activated plugin gets reference and value; refusals; rotation; env reference; unresolvable reference refuses the host start before plugin code runs; daemon kill | `secrets/plugins.spec.ts` › a plugin credential is stored as a reference… | pass (before) |
| Purge deletes the plugin's items; uninstall without purge keeps them | same | pass (before) |
| Free-text plugin credentials migrate on open (`env:`/`keychain:` text becomes a reference; other text moves into the Keychain) | `secrets/plugins.spec.ts` › a plugin credential stored as text… | pass (before) |
| Existing redaction specs still hold with references | `services2/secrets.spec.ts` (2 tests) | not run: blocked by `securityd` |
| A backup withholds ADE-owned references; the restored service needs the value again | `backup/secrets.spec.ts` | not run: blocked by `securityd` |
| Crash between the Keychain write and the database commit | none | not covered: no deterministic injection point |

"pass (before)": each of the five `secrets` specs passed against real daemon
and runtime processes (four in one run, the fifth in a rerun after a fixture
fix). A later combined run could not create keychains once `securityd`
stopped answering. The final code differs from what passed only by
`cargo fmt` and the opt-in keychain fixture.

## Requirement status

No requirement is claimed as newly accepted. F089 and F059 are **partial**:
every criterion above has a spec that passed, but the final combined run,
and the two existing secret specs in `services2` and `backup`, could not run
after `securityd` failed. Rerun
`ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/secrets e2e/protocol/services2 e2e/protocol/backup e2e/protocol/plugins`
once the Keychain answers again.

## Product changes

- `ade-core::credentials`: `CredentialReference` (`{env}` or `{keychain}`),
  `ADE_KEYCHAIN_SERVICE` ("ADE secret"), validation (an environment name must
  be uppercase, so a pasted token is refused), and legacy plugin string parsing.
- `ade-core::services::Config` gains `secret_refs`. `plan_secrets` (pure)
  replaces `keep_secrets`: a sent value is handed to the daemon to store, a
  placeholder keeps the stored reference, a sent ADE-owned reference is
  accepted only for the secret it was made for. `ensure_secrets_present`
  refuses a secret with no reference (withheld by a backup, or still in plain
  text). `withhold_secret_values` also drops ADE-owned references, so a
  restored profile never shares the source's items.
- `ade-daemon::credentials`: resolution and storage through the Security
  framework (FFI; no new crate). `ADE_KEYCHAIN` confines ADE to one keychain
  file; user interaction is disabled, so a locked keychain is an error, not a
  prompt. New items get a random account suffix; `Pending` deletes items made
  for a change that did not commit.
- `service.configure` stores new items only after the running and revision
  checks, reuses the item that already holds the value, and deletes items no
  longer named after commit. `service.remove` deletes its items.
  `service.start` resolves references in phase 2, before any reservation.
- `Store::migrate_service_secrets` runs when the profile opens, with
  `secure_delete`, `VACUUM` and a truncating checkpoint so no copy stays in the
  database files.
- Plugins: `credential_ref` values must be typed references;
  `{"secret": "..."}` moves a value into the Keychain; replies show a legacy
  free-text value as `[redacted]`; `LaunchSpec.credentials` resolves at each
  host start and reaches the plugin as `context.credentials`; a missing
  reference fails the start before plugin code runs; purge deletes items;
  free-text values migrate on open.
- `packages/plugin-host`: `activate` accepts `credentials` and exposes
  `context.credentials`.
- Contracts regenerated (`secret_refs`, `CredentialReference`).

Pure-core tests: `ade-core credentials::tests::*`,
`services::tests::{secret_values_are_redacted_and_kept_only_from_a_stored_secret,
a_reference_is_stored_as_sent_and_never_alongside_a_value,
a_value_stored_before_references_is_never_launched_and_moves_on_the_next_save,
a_backup_copy_withholds_every_secret_value_and_a_restored_service_cannot_start_until_resent}`,
and `plugins::manifest` credential cases.

## Fixtures

- New `e2e/protocol/fixtures/keychain.ts` (`ScratchKeychain`).
- `profile.ts`: `ProfileOptions.keychain`, `profile.keychain`, and
  `ADE_KEYCHAIN` for every daemon. `index.ts`: the `keychain` test option.
- `fixtures/plugins/backend/backend.mjs`: the activate record gains
  `token_reference` and `token_sha256` (a digest, never the value).
- Updated specs in other areas, for the changed contract: `plugins/lifecycle.spec.ts`
  (typed reference; a `keychain:` string is refused), `services2/secrets.spec.ts`
  and `backup/secrets.spec.ts` (opt in to the keychain).

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/secrets`: 4 passed, then the fifth passed alone.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/plugins e2e/protocol/services2`
  (final build): 27 passed; the 2 `services2/secrets` tests failed at
  `create-keychain` because `securityd` did not answer.
- `pnpm check:static`: pass (759 Rust tests).
- No `ade-daemon` or `ade-runtime` from this worktree left running.

## Open

- Plugin credential references in `sessions.plugins.sqlite3` are copied into
  backups as they are. They hold no secret; a restore on the same machine
  resolves the source profile's items. The backup could drop ADE-owned plugin
  references as it does for services (backup domain).
- Remote pairing tokens keep their own `TokenReference`, which has the same
  shape as `CredentialReference`, and nothing resolves them yet.
- A daemon killed between a Keychain write and the database commit leaves an
  orphan item that nothing names. It is never a dangling reference.
- Items made by a dev build are trusted to that build's code signature. A
  rebuilt ad-hoc binary may be refused access (never prompted) to items an
  earlier build made. Signed releases keep one identity.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 110 | 10 | 40 | 0 |

References:
- docs/proposed-architecture.md section 7
- .scratch/ade-v1/evidence/e2e-fix-service-secrets.md, e2e-services2.md, e2e-plugins.md
- crates/ade-daemon/src/remote.rs (`TokenReference` pattern)
