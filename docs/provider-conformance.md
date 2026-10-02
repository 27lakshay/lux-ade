# Provider conformance evidence

This page records what each provider integration was proven to do, in which evidence tier, and what it does not do. Code wins if this page and the code disagree. The worker protocol itself is in [provider-worker-protocol.md](provider-worker-protocol.md).

Recorded 2026-10-02 on agent-work-2 (base commit `48949704` plus uncommitted work), on darwin 25.6.0 arm64, Node 24.19.0, Bun 1.3.14. Every provider runs as a provider worker through the public `@ade/provider-sdk` 0.2.0 (Effect `4.0.0-rc.118`), started by the runtime's one worker supervisor (`crates/ade-runtime/src/provider_worker.rs`), with no second in-process supervisor. Correctness suites run with zero retries.

## Evidence tiers

Results from one tier never stand in for another.

- **Fixture:** a deterministic native peer (mock app-server, SDK double, mock CLI, mock server or fixture ACP agent) behind the real worker, daemon and runtime processes. Normal protocol and desktop suites.
- **Installed:** the real native executable on this machine, without a model account where the tier allows it.
- **Live:** the real executable with the account already signed in on this machine, through a disposable ADE profile. Opt-in only (`ADE_RUN_LIVE_PROVIDERS=1` or the provider's own live variable); the default suites never touch an account.
- **Packaged** and **performance** results are recorded separately (`e2e/packaged`, `pnpm test:performance`).

## Matrix

| Provider | Worker | Native version (installed/live) | Fixture | Installed | Live |
| --- | --- | --- | --- | --- | --- |
| Codex | `providers/codex/worker.mjs` over the Rust native client | codex-cli 0.159.0 | full protocol and desktop suites | via live | pass: reply, tool, Stop then resume, approval, decline (`live-provider-c8b775a3-0c1b-46fa-9087-7f2b074aa5e5`); steering a running turn (`live-provider-38fb3528-644c-4380-8469-523f09721865`) |
| Claude Code | `providers/claude/worker.mjs`, Claude Agent SDK 0.3.281 | 2.1.287 | full suites, SDK double | installed SDK/CLI loopback (ticket 06) | pass: same steps, read permission and decline via `deny` (`live-provider-21ba2d39-dfd5-44f3-b13a-4dddbb8bf99d`) |
| Oh My Pi | `providers/omp/worker.mjs` (Bun), package pin 18.3.0 | omp 18.4.10 | full suites, mock CLI | via live | pass: reply, tool, Stop then resume; approval not applicable (`live-provider-4e5ade70-9165-41fa-b945-d733e9654851`) |
| Generic ACP | `providers/acp/worker.mjs`, `@agentclientprotocol/sdk` 1.5.1 | `opencode acp` 2.0.22 | fixture ACP agent, protocol and desktop | `opencode acp` | pass: completion and `session/resume` (`protocol-c66f3180-7193-424c-9fb4-32ec44594e84`) |
| OpenCode (plugin) | `plugins/opencode`, installed with `plugin.install`; artifact `sha256:4db5448d85bd5731ac70c00d62792e044af9aeeaf55615e6738d6c09c42e1d34` | opencode 2.0.22 | mock server, protocol and desktop | pass (`providers-installed-89b73330-6fbc-4fad-b82b-25f0dbc76566`) | pass: one reply (`protocol-b285ea97-095b-435d-96c4-9dc5fdee2bf6`) |

Account context in every live run: the machine's own (ambient) login of that provider, used through a disposable ADE profile; no managed ADE account.

## Declared capabilities

Each worker declares its operations at `initialize`; that declaration, not the provider's name, is what ADE offers. Controls for a provider plugin follow the same declaration as a bundled worker's (see below).

| Operation | Codex | Claude | Oh My Pi | Generic ACP | OpenCode plugin |
| --- | --- | --- | --- | --- | --- |
| send, cancel, answer | yes | yes | yes | yes | yes |
| steer | yes | no | no | no | no |
| compact | yes | no | yes (RPC `compact`) | no | no |
| rewind (conversation) | yes (thread fork) | yes (session fork, by native message) | no | no | no |
| history | yes | yes | yes | no (replayed only when `session/load` opens a session) | yes |
| child transcript | yes | yes | yes | no | yes |
| native tool approval | yes | yes | no (only extension confirmations) | yes (agent's option IDs) | yes |
| MCP configuration | yes | yes | yes (extension package) | no | no |
| managed accounts | yes (bundled probe) | yes (bundled probe) | yes (bundled probe) | no | no (no `account_inspect`) |

Each "no" carries the worker's reason in `conversation.controls` and `provider.inspect`.

## Privileged routes

Ticket 31 looked for any route a bundled provider uses that an independently installed worker cannot; the PC02 follow-up closed the ones it left.

- Removed: conversation controls were decided by provider name. Every worker-backed provider is now decided by its worker's declared operations, with the worker's own reason when one is unavailable (`sessions/controls/availability.rs`): Codex, Claude and Oh My Pi by the descriptor their workers answer `initialize` with (`ProviderEntry::worker_descriptor`), a plugin by what its worker declared at its last handshake, a generic ACP adapter by what its probe recorded. A custom executable adapter is not a worker and says so. The reported mechanism is the worker operation (`worker.steer`, `worker.compact`, `worker.rewind`) for every provider; the native method behind it is the worker's own. Oh My Pi's worker implements `compact` through its RPC, so Oh My Pi compaction is now offered.
- Removed: MCP servers reached only the three bundled providers. Any worker that declares `configure_mcp` receives the resolved profile catalog before `open` at launch and resume, through the same runtime call; a provider without a native projection gets the provider-neutral `worker_mcp_json` one, and `mcp.resolve` and `mcp.server.inspect` report it and whether it is wired (`e2e/protocol/adapters/plugin-providers.spec.ts`, MCP case).
- Removed: plugin providers could not run on managed accounts, and Codex received its account through a private variable. Every worker on a managed account now receives the same public `ADE_ACCOUNT_CONTEXT` (`ProviderWorkerAccountContext`). A plugin whose worker declares `account_inspect` supports managed accounts: `account.create`, `account.inspect` (run through its own worker in the account's cleared, home-isolated environment), `account.verify` (pinning the reported identity) and conversations on the account, which the runtime fences by re-inspecting before each `open` and `send` (`plugin-providers.spec.ts`, managed-account case).
- Removed (D19): the in-process Claude and Oh My Pi bridge adapters (`claude.rs`/`omp.rs` `Adapter`, `providers/claude/bridge.mjs`, `providers/omp/bridge.mjs` and their tests and fixtures). Nothing launched them; both providers run only through their public workers.
- Kept, documented: Codex's worker drives a Rust native client beneath the public SDK facade; the boundary the daemon sees is the same worker protocol.
- Kept, documented: a bundled provider's managed logins are read by ADE's bundled account probes (`account_probe`, `codex_probe`, `omp_probe`) before its worker starts, and its workers declare `account_inspect` unsupported with that reason. An installed provider does the same through `account_inspect`; both reach the same daemon verification, pinning and generation fencing. Moving a conversation to another account (`account_switch`) remains bundled-only.

## Defects found by the live tier

- Oh My Pi 18.4 acknowledged an abort and went idle without `agent_end`; the turn stayed running and the Stop unresolved. The worker now ends the attempt as interrupted from the post-abort idle sample (fixture `hold-silent-abort`, `conversations/stop.spec.ts`).
- Oh My Pi declared native tool approval but ran its bash tool without asking; it now declares tool approval unsupported.
- OpenCode duplicated a reply when the model reasoned before answering; text is now keyed by OpenCode's fragment ordinal (found and fixed in ticket 21).
- The live probe itself had drifted from the contracts (page limit, idle status, untyped answers, request fields) and matched an accept choice whose value contained the word "declined" in a path; it now uses the typed contracts and exact choice names.

## Gaps

- Generic ACP: only OpenCode's ACP mode is verified, for completion and resume; cancellation, permissions and load replay are fixture-only.
- OpenCode plugin: Stop, permissions and child transcripts are fixture-only.
- Claude native history in the desktop with the SDK double reads Claude's own session files, which the double does not write; desktop tests show it as an explicit failure.
- No managed-account (ADE-isolated login) live run for any provider.
- Oh My Pi's package pin (18.3.0) and the installed binary (18.4.10) differ; the live evidence is for 18.4.10.
- The author conformance harness (`pnpm test:conformance`, fixture tier, worker protocol only; see [provider-authoring.md](provider-authoring.md#conformance-checks-without-ade)) first found that Claude, ACP and OpenCode each ran a retried send again (a second turn, or for OpenCode a turn that never finished). The SDK runner now answers a repeated submission with the first send's reply, so all three pass all 13 checks. Oh My Pi and Codex are not yet run under the harness.
