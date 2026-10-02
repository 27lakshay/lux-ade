# OpenCode provider plugin

OpenCode v2 as an ADE provider plugin. It is packaged and installed like any third-party
plugin: `plugin.install` from a directory, then `plugin.enable`. ADE core has no OpenCode
code; the daemon runs this plugin's worker as provider `plugin:ade.opencode` through the
public provider worker protocol ([docs](../../docs/provider-worker-protocol.md)).

## Install

```sh
pnpm build:sdk            # builds the plugin and assembles plugins/opencode/artifact
ade plugin install local plugins/opencode/artifact --operation-id install-opencode
ade plugin enable ade.opencode
```

The artifact carries its whole runtime: the plugin, `@ade/provider-sdk`, `@ade/contracts` and
the pinned `effect` 4.0.0-rc.118 (`scripts/package-provider-plugin.mjs`). It needs Node 22 or
later and an installed OpenCode v2.

OpenCode is found in this order: `ADE_OPENCODE_BIN` (absolute path), `opencode` on `PATH`, then
the official installer's `~/.opencode/bin/opencode`. The worker reads `opencode --version` when
it initializes and names the provider after it (`OpenCode 2.0.22`). If OpenCode is missing or
not v2, every native operation is declared `unavailable` with the reason, and
`provider.readiness` reports `unavailable` with a failed `provider.native_work` check.

OpenCode uses its own configuration and sign-in (OpenCode integrations and credentials). ADE
does not manage OpenCode accounts. Each conversation owns a private `opencode serve --stdio`
server started in the workspace.

## Capability matrix

| Area | Behaviour | Evidence |
|---|---|---|
| Open and resume | Creates or reopens a native session; a reopened session must be in the same directory. Waits up to 10 s for the chosen model to appear in OpenCode's model snapshot. | fixture, installed |
| Send | Admission is serialized: refused while OpenCode reports another active run or queued input. The native prompt ID is `msg_<ADE message ID>`, so a retried dispatch names the same prompt. A lost reply is reconciled by reading the inbox and transcript; nothing is resent. | fixture, installed, live |
| Text and tools | Live text deltas, then the stored transcript reconciles them into one item per text fragment. Tool calls and results carry ADE tool content. Private reasoning is not shown. | fixture (tool), installed and live (text) |
| Completion | Only OpenCode's durable `idle` record for the turn finishes it (`completed`, `failed` or `interrupted`). | fixture, installed, live |
| Stop | `interrupt` with `resume=false`, then a state sample: scope `session`, `confirmed` only when the turn's interrupted idle record exists, otherwise `requested` with active and queued counts. | fixture |
| Requests | Permission requests offer `once` or `reject`; forms with string fields become questions, others are shown as unsupported. Answers are fenced to the current turn. | fixture |
| Recovery | A worker that dies after OpenCode accepted a prompt leaves it accepted with no terminal; reopening sends nothing. A prompt OpenCode still holds unexecuted is disclosed as a request and runs again only on an explicit resume. | fixture |
| History | `history` pages the stored transcript (32 items, 512 KiB) with a cursor fenced to the transcript length and last message. Consistency is `best_effort`. | fixture, installed |
| Child transcripts | Pages of a subagent session's messages, verified to belong to the parent. | unit |
| Attachments | Images become file parts; text attachments are appended to the prompt. | unit (session API) |
| Steering, compaction, rewind | Unsupported: OpenCode has native routes, but this plugin does not wire them yet. ADE offers each control to a plugin worker that declares it available. | descriptor |
| MCP configuration | Unsupported: OpenCode reads MCP servers from its own configuration. | descriptor |
| Managed accounts, usage, quota | Not provided: the worker declares no `account_inspect`, so ADE manages no OpenCode account, and it reports no usage. | descriptor |

## One authoring path

`src/session.ts` is the only execution path: an Effect service whose methods run the native
engine with typed `{ code, message }` failures, interruption that aborts in-flight reads, and a
scope that stops the owned OpenCode server. `src/worker.ts` hands it to `runProviderWorker`.
`src/client.ts` exposes the same effects as Promise methods (an `AbortSignal` interrupts the
fiber) and the event stream as an `AsyncIterable`; `dispose()` closes the same scope.
`test/client.test.mjs` checks that both interfaces fail with identical typed failures, cancel
by abandoning the native read, and confirm the server exit on disposal.

## Tests and evidence

| Tier | Command | What runs |
|---|---|---|
| Unit | `pnpm test:providers --provider opencode` (part of `pnpm check:static`) | Engine, transport, session API, transcript and interface tests; the client test uses the fixture server. Build first. |
| Fixture | `pnpm test:e2e:protocol:only e2e/protocol/adapters/opencode-plugin.spec.ts`; `pnpm test:e2e:desktop:only e2e/desktop/opencode-plugin.spec.ts` | Real daemon, runtime and built desktop with the packaged plugin installed; OpenCode is `test/fixtures/mock-opencode.mjs`. |
| Installed | `pnpm test:providers:installed --provider opencode` (sets `ADE_OPENCODE_LOOPBACK_BIN`) | The installed OpenCode with scratch configuration and a local model endpoint, through the real daemon. No account. |
| Live | `ADE_RUN_LIVE_PROVIDERS=1 ADE_OPENCODE_LIVE_BIN=… ADE_OPENCODE_LIVE_MODEL=provider/model pnpm test:e2e:protocol:only e2e/protocol/adapters/opencode-native.spec.ts --grep live` | One minimal prompt with the machine's OpenCode sign-in; fails if the stored credentials file changes. |

Installed and live cases skip without their variables. Each attaches an evidence record with
the artifact digest, OpenCode version, account context and capability matrix.

Provenance: [PROVENANCE.md](PROVENANCE.md). OpenCode's MIT notice: [LICENSE-opencode](LICENSE-opencode).
