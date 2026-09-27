# E2E round 3: secret references (F089 at rest, F059 credentials)

Status: returned
Type: slice evidence
Branch: claude/wf_c51346dc-a4d-1 (merges claude/wf_317b0f50-41b-1)
Worker: secrets finish, after the 2026-09-27 login incident
Requirements: F089, F059

## Machine safety

The first attempt at this slice created scratch keychains and ran
`/usr/bin/security` from specs. The machine's `securityd` then stopped
answering, and the user could not log in until a safe-mode boot. This round
removes every path from tests to the Keychain:

- `crates/ade-daemon/src/credentials.rs` has a `SecretStore` trait with two
  backends. `KeychainStore` is the production backend; its Security framework
  code is unchanged. `file::FileStore` is an encrypted file, compiled only in
  debug builds and chosen only by `ADE_SECRET_STORE=file`.
- A release build refuses `ADE_SECRET_STORE=file` at start-up and contains no
  file store. Checked by hand: a `--release` daemon started with it exited 1
  with "ADE_SECRET_STORE=file selects the test-only secret store, which a
  release build refuses", before it started a runtime.
- The store is chosen once, by `credentials::init` in `serve`, before any
  store opens. Until then every secret operation fails; nothing falls back to
  the Keychain. Rust unit tests never call `init`, so they cannot reach it.
- `scratchEnvironment` sets `ADE_SECRET_STORE=file`, `ADE_SECRET_FILE` and
  `ADE_SECRET_KEY` for every process a spec starts, including daemons that
  `ade-control` starts. `ScratchProfile` refuses to launch a daemon without
  the file store or with `ADE_KEYCHAIN`.
- `e2e/protocol/fixtures/keychain.ts` is deleted. No spec or fixture runs
  `/usr/bin/security`, `codesign` or keychain commands.

Every run in this round used `ADE_E2E_WORKERS=2`. No run called the Security
framework or the `security` tool.

## Outcome

Service secrets and plugin credentials are stored as credential references;
values live in the secret store. Ownership is per profile, which fixes the
review blocker: a profile restored beside the original could delete the
original's Keychain items through copied plugin credential references.

- Every item ADE makes has the account `<owner>/<scope>/<random>`. The owner
  ID is in `<data dir>/secret-owner`, which a backup never copies.
- A profile reuses or deletes only items whose account starts with its own
  owner ID. Deleting another profile's item is refused and logged.
- Backup format 6 drops plugin settings that name an item ADE made, declares
  the exclusion in `excluded` and `coverage`, and refuses a format-6 bundle
  that still names one. Restore drops them too, which covers format-5
  bundles. Format 5 still restores.

F089 and F059 are accepted; see the tables below.

## Acceptance criteria

07 F089: "Resolve declared dependencies/endpoints, show effective nonsecret
configuration and detect unavailable dependencies without silent
substitution." Architecture section 7: store secret references, not raw
credential-bearing launch environments.

| Criterion | Spec | Result |
|---|---|---|
| A sent value moves into an item; the store file holds it encrypted, no profile file holds it; replies and CLI never show it; the process gets it | `secrets/services.spec.ts` › a secret sent as a value moves into the secret store… | pass |
| Duplicate configure converges; a running or conflicting edit makes no orphan; an ADE item cannot be copied to another secret; rotation deletes the old item; a daemon kill; remove deletes the item | same | pass |
| `{env}` and user references resolve only at launch, never cached; one that names nothing refuses the start before any reservation; refused shapes; a user item is never deleted | `secrets/services.spec.ts` › references resolve only at launch… | pass |
| Plain-text secrets move into the store on open; while the store is unavailable they are never shown or launched | `secrets/services.spec.ts` › a secret stored in plain text… | pass |
| Effective nonsecret configuration everywhere ADE shows it | `services2/secrets.spec.ts` (2 tests) | pass |
| A backup withholds service values and ADE-owned references; the restored service needs the value again | `backup/secrets.spec.ts` › a backup withholds secret service values… | pass |
| Declared peers resolve; cycles, unknown services and missing ports are refused; a lost or foreign-held peer is reported, not substituted | `services/peers.spec.ts` (3 tests) | pass (full run) |

04 F059: "Persist namespaced records/settings and credential references;
prevent accidental namespace collisions and document private-data backup
exclusions."

| Criterion | Spec | Result |
|---|---|---|
| Namespaced records and settings, kept apart across plugins, a restart and an uninstall | `plugins/lifecycle.spec.ts` › keeps namespaced records and settings apart… | pass |
| Credential settings hold typed references; `{secret}` moves a value into the store, encrypted at rest; the activated plugin gets reference and value; refusals; rotation; env reference; an unresolvable reference refuses the host start; purge deletes items | `secrets/plugins.spec.ts` › a plugin credential is stored as a reference… | pass |
| Free-text credentials migrate on open | `secrets/plugins.spec.ts` › a plugin credential stored as text… | pass |
| Backup exclusions are documented: plugin-private files, and plugin credential references to items ADE made | `backup/restore.spec.ts`, `backup/secrets.spec.ts` › a restored profile beside the original… | pass |
| A restored profile sharing the original's store has its own owner, cannot adopt the original's item, and neither reuses nor deletes it through a copied reference; purge deletes only its own item; the original still activates with its value; a leaky format-6 bundle fails verification | `backup/secrets.spec.ts` › a restored profile beside the original… | pass |

The last spec was checked against a mutation: with the ownership check in
`delete_owned` disabled, it fails.

Not covered: a daemon killed between the store write and the database commit
leaves an orphan item that nothing names. There is no deterministic
injection point.

## Operation tiers

No operation was added. `service.configure` and `plugin.setting.set` keep
their tiers. Backup format 6 changes `ade-control backup` output only.

## Checks

- `pnpm build:backend && pnpm build`: pass.
- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/secrets e2e/protocol/services2 e2e/protocol/backup e2e/protocol/plugins e2e/protocol/services/peers.spec.ts` (final build): 48 passed.
- Full protocol suite, `ADE_E2E_WORKERS=2`, before the format 6 change: 512 passed, 34 skipped (system-service and opt-in specs). The backup and plugin specs were rerun after it, above.
- `pnpm check:static`: pass (777 Rust tests).
- In-process tests added: `ade-daemon credentials::tests` (the store is chosen
  only by name, never in a release build), `credentials::file::tests`
  (round trip, encrypted at rest, wrong key refused, missing directory),
  `ade-core credentials::tests` (`owned_by`), `backup::coverage::tests`
  (format 6 declares the exclusion; format 5 still reads).
- `pgrep`: no `ade-daemon`, `ade-runtime` or `security` process from this
  worktree left running.

## Product changes

- `ade-core::credentials`: `CredentialReference::owned_by(owner)`.
- `ade-daemon::credentials`: `SecretStore`, `Backend`, `backend()`, `init()`,
  `owns()`, the file store, and owner-scoped `store_new`, `owned_holds` and
  `delete_owned`.
- `ade-daemon` server: `credentials::init` before any store opens.
- `ade-control` backup: format 6, `withhold_plugin_credentials` on backup and
  restore, `plugin_credentials_withheld` on backup and inspect.

## Fixtures

- New `e2e/protocol/fixtures/secret-store.ts` (`ScratchSecretStore`,
  `secretStoreEnvironment`), in the file store's format.
- `environment.ts`: the file store for every spec process. `profile.ts`:
  `profile.secrets` and the launch guard. `index.ts`: back to its form before
  the keychain option.
- `backup/helpers.ts`: `restoreIntoNewProfile` takes profile options;
  `rewriteDatabase` takes a database name.
- Deleted `fixtures/keychain.ts`.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 10 | 35 | 10 |

## References

- docs/proposed-architecture.md section 7
- .scratch/ade-v1/evidence/e2e-services2.md, e2e-plugins.md
- None copied.

## Open

- `crates/ade-daemon/src/sessions/remote.rs` `resolve_token` runs
  `/usr/bin/security find-generic-password` for a pairing token that names a
  Keychain item. No spec uses such a reference today, but a spec that did
  would reach the user's login keychain. It should resolve through
  `credentials::resolve` (remote domain).
- The production Keychain backend is unchanged and was not exercised in this
  round. AGENTS.md says it is checked only by hand, with the user present.
- Items made before owner IDs (accounts without the prefix) are never reused
  or deleted by any profile. Only unreleased builds made them.
- Shared files: `AGENTS.md` already states the file-backend rule. The
  requirements register and progress need F089 and F059 marked accepted.
