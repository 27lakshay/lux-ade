# Account context foundation (F025/F027)

Status: implementation in progress. Account registration alone does not complete F025 or F027.

## Contract

An account belongs to one ADE profile and one provider. Its stable ID, display name, ADE-owned native home, generation, and verification state are durable profile metadata. A new account starts at generation 0 with state `unverified`; creating it does not authenticate, validate credentials, or prove that the provider can run. The native home is private to the profile. Credentials remain native or behind secret references and are never stored in the account response.

`account.create` accepts a provider ID and name. `account.list` returns registered metadata. `conversation.create` accepts an optional `account_id` and rejects a missing account or provider mismatch. A conversation pins its account ID and exposes `account_context: managed`. Existing and newly created conversations without an account ID expose `account_context: legacy_ambient`; this preserves their current process environment behavior and makes that limitation visible. A stored conversation cannot change its account association through normal updates.

The daemon passes a managed conversation's account ID, provider, native home, generation and pinned identity to its runtime execution context. It derives the native home from the active profile and rejects redirected or overly accessible account directories. Managed OpenCode still rejects execution. The earlier live Oh My Pi run exercised ambient authentication through the Bun bridge, not a managed account.

Managed Oh My Pi v18.3.0 now supports one identified OAuth credential per private account home. `account.inspect` checks the pinned native version and reads the native `agent.db` credential metadata with Bun SQLite in read-only mode. It returns provider, native credential row ID, native identity key and account identifiers, never token data. The native database must be a private regular file with one link; no active credential, multiple active credentials, or an unrecognized schema fail closed. `account.verify` pins the inspected identity with a generation fence. The runtime repeats the inspection before bridge launch, before session open and before each turn. The managed bridge uses the account home for OMP's agent directory, HOME, and ADE's OMP session ledger; it strips ambient provider keys and checks that OMP's selected model provider matches the pinned credential provider. Native credential row changes are rejected before a new turn. This is a bounded native account mode, not a claim that every OMP auth mode is supported.

The pinned CLI accepts `config.yaml` as well as `config.yml` for broker discovery and loads dotenv after launch from the workspace, HOME, config root and agent dir. Managed mode rejects native config/model overrides, broker token files, project `.omp` config, and `.env*` files at those locations before launch and every turn. The Bun bridge and default OMP CLI use `--no-env-file` to suppress Bun's own dotenv autoload. Refusing a workspace `.env` is an intentional limitation until OMP offers a native exact-credential binding that cannot fall back to a file-loaded API key.

Managed Codex uses a private `CODEX_HOME` with `cli_auth_credentials_store = "file"` and a sanitized environment. Its bounded app-server inspection reads effective configuration and native ChatGPT account identity without returning tokens. This slice accepts only native Codex 0.157.0 and requires its observed experimental `workspaceRouting.chatgptAccountId` alongside email. Missing routing, changed identity, keyring or gateway overrides, unsafe or hard-linked credential files, and an unrecognized version fail closed. The selected workspace-routing response is not a stable documented identity contract, so actual hosted-account validation and a compatibility plan remain required. The managed adapter repeats identity readback in the launched app-server before opening a session and before each new turn.

For Claude, `account.inspect` runs a fresh bounded `claude --version` and `claude --setting-sources '' auth status` through the runtime in a sanitized environment with `CLAUDE_CONFIG_DIR` and `ANTHROPIC_CONFIG_DIR` set to the account home. The setting-sources syntax was checked against the installed CLI; the flag must precede `auth status`. It reports missing executable, unauthenticated, incompatible or ready without returning raw command output. The current parser accepts Claude Code 2.1.283 or a later 2.1.x patch only when all observed status fields are present and identify a first-party subscription account. This is a compatibility gate over an undocumented JSON shape, not a guarantee for future releases. `account.verify` saves the observed identity only when the caller's expected generation still matches. Managed Claude launch runs the same fresh check before starting its SDK sidecar, rejects identity drift and nonempty settings sources, and gives the sidecar the same sanitized environment. External CLI replacement is rechecked at each inspection and launch. Native login remains in the unmodified Claude CLI; ADE stores no token.

`account.disable` is an ADE-only binding change: it increments generation, clears the verified identity and fences a late `account.verify`. It does not log out the native CLI or interrupt an active turn. The daemon rejects future sends and resumes for a disabled account, including an Agent already connected before Disable. Native logout/readback and its full R012 race acceptance remain separate work.

Inspect-to-verify consent is fenced: `account.verify` requires the complete
`expected_identity` returned by a prior `account.inspect`, plus its generation.
The daemon performs a fresh native probe and rejects an identity change even
when the ADE generation has not changed. The CLI accepts that identity as JSON;
the Electron Accounts view forwards the inspected identity. The view offers
shell-quoted native Claude, Codex and Oh My Pi login commands, displays inspected and pinned
identities, and labels legacy ambient conversation selection explicitly. A
profile switch during a delayed inspection cannot render the prior profile’s
identity or enable Verify in the new profile.

After runtime creation, the daemon rechecks the account's generation, verified state and pinned identity immediately before opening the provider session. A disable during the native launch probe prevents that session and its prompt from being admitted. The probe records the resolved Claude executable's file identity and modification metadata before and after status checks; a replacement during that check fails closed. Replacement after the last check but before a later SDK-owned CLI invocation remains a native handoff race, so fresh checks still run on every ADE launch and resume.

## Acceptance remaining

- Run two conversations for the same provider under different real accounts and verify native credential and session separation.
- Run managed Oh My Pi against a hosted account. The deterministic native OAuth fixture proves account isolation and drift fencing, but no hosted OMP credential is available on this Mac. Add API-key, broker, and multi-credential account modes only with a native exact-credential resolver that cannot silently rotate or fall back. Revisit native config/model override policy and compatibility beyond OMP 18.3.0.
- Validate the 2.1.x status schema and identity match against actual hosted Claude accounts and the installed SDK before claiming F025/F027 completion.
- Exercise native credential refresh and logout, including late readback, before claiming R012 completion.
- Record real-provider evidence separately from deterministic external protocol fixtures, as required by the provider specification.

The running-daemon `codex-account-readiness.spec.ts` uses an external native
app-server fixture to exercise two private homes, inspection-to-verification
drift, sanitized launch, same-process per-turn drift readback, hard-linked
file rejection, and Disable fencing on connected and delayed Agents. These
fixture results do not establish hosted Codex account compatibility.

The running-daemon `omp-account-readiness.spec.ts` drives the CLI and public
protocol with two private OMP native database fixtures and the real Bun bridge.
It verifies read-only identity metadata, two independent sessions and turns,
ambient environment removal, private HOME, credential drift before a turn,
ADE-only disable, and fail-closed multi-credential/model-override and workspace
`.env` states. The deterministic native RPC fixture records its process
environment; it does not exercise OMP's credential-selection cascade.
The focused E2E passed 1/1 on 26 September 2026 after building the daemon and
native-terminal runtime binaries. It does not establish hosted OAuth refresh,
logout or native model behavior; F021/F025/F027/R012 remain in progress.

Integrated evidence (26 September 2026, macOS arm64): the running-daemon
`account-readiness.spec.ts` rejects a changed identity between Inspect and
Verify. `desktop-accounts.spec.ts` exercises Claude and Codex account creation, readiness,
verification, conversation binding, ADE-only disable, identity drift and a
paused probe across a profile switch through hidden Electron. The CLI’s
`local-cli.spec.ts` verifies and sends through a managed Claude home using an
external CLI/SDK fixture. The 52-case `pnpm check` suite, Rust formatting and
strict Clippy pass on the combined source tree. Hosted two-account verification
and native logout remain open; fixture passes do not establish them.

The hidden Electron `desktop-accounts.spec.ts` also creates a managed Oh My Pi
account, executes its displayed login command from a workspace with broker
dotenv and ambient variables, and confirms that the command uses the private
home and rejects a different CLI version. It then inspects and verifies a native
database fixture and sends a conversation through the real daemon and Bun
bridge. The combined Claude, Codex and Oh My Pi account E2Es pass 7/7. This is
desktop workflow evidence; the native RPC fixture does not prove hosted OAuth.
