# Account context foundation (F025/F027)

Status: implementation in progress. Account registration alone does not complete F025 or F027.

## Contract

An account belongs to one ADE profile and one provider. Its stable ID, display name, ADE-owned native home, generation, and verification state are durable profile metadata. A new account starts at generation 0 with state `unverified`; creating it does not authenticate, validate credentials, or prove that the provider can run. The native home is private to the profile. Credentials remain native or behind secret references and are never stored in the account response.

`account.create` accepts a provider ID and name. `account.list` returns registered metadata. `conversation.create` accepts an optional `account_id` and rejects a missing account or provider mismatch. A conversation pins its account ID and exposes `account_context: managed`. Existing and newly created conversations without an account ID expose `account_context: legacy_ambient`; this preserves their current process environment behavior and makes that limitation visible. A stored conversation cannot change its account association through normal updates.

The daemon passes a managed conversation's account ID, provider, native home and generation to its runtime execution context. It derives the native home from the active profile and rejects redirected account directories, including symlinks. Every bundled provider currently rejects managed execution before launching a native process. This is deliberate: Claude can select higher-priority ambient credentials or settings, Codex can use the OS keyring, and Oh My Pi can rotate among saved OAuth credentials. Provider adapters must apply their native state rules, validate actual identity and readiness, and reject unsupported account execution without falling back to ambient credentials. The durable context must also be checked on resume. Credential refresh may change credential material without changing account ID; logout must fence delayed refresh and readback before account state can be considered verified.

## Acceptance remaining

- Run two conversations for the same provider under different real accounts and verify native credential and session separation.
- Probe missing executable, invalid credentials, incompatible version and ready states for the selected account; revalidate an externally replaced CLI.
- Race refresh and logout, and verify delayed work cannot restore the logged-out account.
- Record real-provider evidence separately from deterministic external protocol fixtures, as required by the provider specification.
