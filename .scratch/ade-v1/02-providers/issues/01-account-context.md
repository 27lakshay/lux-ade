# Account context foundation (F025/F027)

Status: implementation in progress. Account registration alone does not complete F025 or F027.

## Contract

An account belongs to one ADE profile and one provider. Its stable ID, display name, ADE-owned native home, generation, and verification state are durable profile metadata. A new account starts at generation 0 with state `unverified`; creating it does not authenticate, validate credentials, or prove that the provider can run. The native home is private to the profile. Credentials remain native or behind secret references and are never stored in the account response.

`account.create` accepts a provider ID and name. `account.list` returns registered metadata. `conversation.create` accepts an optional `account_id` and rejects a missing account or provider mismatch. A conversation pins its account ID and exposes `account_context: managed`. Existing and newly created conversations without an account ID expose `account_context: legacy_ambient`; this preserves their current process environment behavior and makes that limitation visible. A stored conversation cannot change its account association through normal updates.

The daemon passes a managed conversation's account ID, provider, native home, generation and pinned identity to its runtime execution context. It derives the native home from the active profile and rejects redirected or overly accessible account directories. Managed Codex, Oh My Pi and OpenCode still reject execution. Codex can use the OS keyring, and Oh My Pi can rotate among saved OAuth credentials; neither adapter has the required native readback yet.

For Claude, `account.inspect` runs a fresh bounded `claude --version` and `claude --setting-sources '' auth status` through the runtime in a sanitized environment with `CLAUDE_CONFIG_DIR` and `ANTHROPIC_CONFIG_DIR` set to the account home. The setting-sources syntax was checked against the installed CLI; the flag must precede `auth status`. It reports missing executable, unauthenticated, incompatible or ready without returning raw command output. The current parser accepts Claude Code 2.1.283 or a later 2.1.x patch only when all observed status fields are present and identify a first-party subscription account. This is a compatibility gate over an undocumented JSON shape, not a guarantee for future releases. `account.verify` saves the observed identity only when the caller's expected generation still matches. Managed Claude launch runs the same fresh check before starting its SDK sidecar, rejects identity drift and nonempty settings sources, and gives the sidecar the same sanitized environment. External CLI replacement is rechecked at each inspection and launch. Native login remains in the unmodified Claude CLI; ADE stores no token.

`account.disable` is an ADE-only binding change: it increments generation, clears the verified identity and fences a late `account.verify`. It does not log out the native CLI or stop an already running Agent. Native logout/readback and its full R012 race acceptance remain separate work.

Inspect-to-verify consent is fenced: `account.verify` requires the complete
`expected_identity` returned by a prior `account.inspect`, plus its generation.
The daemon performs a fresh native probe and rejects an identity change even
when the ADE generation has not changed. The CLI accepts that identity as JSON;
the Electron Accounts view forwards the inspected identity. The view offers a
shell-quoted native Claude login command, displays both inspected and pinned
identities, and labels legacy ambient conversation selection explicitly. A
profile switch during a delayed inspection cannot render the prior profile’s
identity or enable Verify in the new profile.

After runtime creation, the daemon rechecks the account's generation, verified state and pinned identity immediately before opening the provider session. A disable during the native launch probe prevents that session and its prompt from being admitted. The probe records the resolved Claude executable's file identity and modification metadata before and after status checks; a replacement during that check fails closed. Replacement after the last check but before a later SDK-owned CLI invocation remains a native handoff race, so fresh checks still run on every ADE launch and resume.

## Acceptance remaining

- Run two conversations for the same provider under different real accounts and verify native credential and session separation.
- Validate the 2.1.x status schema and identity match against actual hosted Claude accounts and the installed SDK before claiming F025/F027 completion.
- Exercise native credential refresh and logout, including late readback, before claiming R012 completion.
- Record real-provider evidence separately from deterministic external protocol fixtures, as required by the provider specification.

Integrated evidence (26 September 2026, macOS arm64): the running-daemon
`account-readiness.spec.ts` rejects a changed identity between Inspect and
Verify. `desktop-accounts.spec.ts` exercises account creation, readiness,
verification, conversation binding, ADE-only disable, identity drift and a
paused probe across a profile switch through hidden Electron. The CLI’s
`local-cli.spec.ts` verifies and sends through a managed Claude home using an
external CLI/SDK fixture. The 50-case `pnpm check` suite, Rust formatting and
strict Clippy pass on the combined source tree. Hosted two-account verification
and native logout remain open; fixture passes do not establish them.
