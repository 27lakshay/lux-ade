# Provider tests

Run all deterministic adapter tests with `pnpm test:providers`. The same command is part of
`pnpm check:static`. Node runs Claude and generic ACP tests and the OpenCode plugin's tests
(`plugins/opencode/test`, after `pnpm build:sdk`); Bun runs OMP tests. Install workspace
dependencies with pnpm; Bun is needed as a test runtime, not as the package manager.

Use `pnpm test:providers --list` to inspect file selection without running tests. To focus a
provider and test name, use:

```sh
pnpm test:providers --provider claude --test-name-pattern 'task|subagent'
```

The Claude and OMP package `test` commands use the same selection. All provider-root
`*.test.mjs` files join deterministic acceptance except `live.test.mjs` and `loopback.test.mjs`.
Those files need a real installed provider or credentials and remain separate acceptance. The
OMP worker's installed-CLI case lives in `worker-peer.test.mjs` and runs only with
`ADE_OMP_LOOPBACK=1`.
New directory layouts need an explicit discovery update; the ownership validator is tracked
in testing infrastructure ticket 03.

The deterministic runner clears `ADE_OPENCODE_LIVE_BIN`, `ADE_OPENCODE_LOOPBACK_BIN`
and `ADE_OMP_LOOPBACK` even if the calling shell opts into external tests.
It preserves runner failures, stops before subsequent providers after a failure, and forwards
SIGINT/SIGTERM to the current runner and fixture process group with bounded teardown.
Correctness retries are not enabled. Name filters narrow this run and do not replace full acceptance.

Runner arguments follow the official [Node test runner](https://nodejs.org/api/test.html)
and [Bun test runner](https://bun.sh/docs/test) interfaces. This wrapper exposes provider
selection, listing and the shared `--test-name-pattern` option; it rejects unknown arguments.

## Oh My Pi native protocol evidence

| Evidence | Observed | Limit |
|---|---|---|
| Workspace pin | `@oh-my-pi/pi-coding-agent` 18.3.0; `omp --version` reported `omp/18.3.0` | This is the installed workspace package, not a separately installed hosted CLI. |
| Native RPC | The adapter negotiates RPC v2 and checks the peer-advertised 1 MiB physical and 64 MiB reassembled frame limits before requests. | The pin does not advertise a general turn-settlement event. `agent_end` is the observable execution boundary; prompt acknowledgement alone is not completion. |
| Prompt-local work | `prompt_result` with matching RPC request ID and `agentInvoked: false` identifies non-agent prompt handling. | Never treat as evidence of model execution. |
| Cancellation | `abort` followed by `get_state` can establish idle/no queued work for a targeted stop. | An interrupt request or error does not, by itself, establish a native cancellation cause. |
| Correlation | RPC IDs correlate command responses; user messages appear in native history; native assistant `responseId` can correlate model output when present. | ADE message/submission IDs are not native turn IDs. Missing `responseId` cannot be replaced by a locally fabricated native ID. |
| Background settlement | No accepted evidence for independent post-yield/background settlement was found in this pin’s RPC implementation. | Report unknown/unavailable; do not infer from newer upstream behavior. |
| Adapter acceptance | `bun test providers/omp/transport.test.mjs providers/omp/worker-peer.test.mjs` runs the public worker against deterministic transport peers. | No live model/authenticated effects are used; installed evidence is in [provider conformance](../docs/provider-conformance.md). |

Upstream references: [Oh My Pi RPC protocol](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md), [repository agent guidance](https://github.com/can1357/oh-my-pi/blob/main/AGENTS.md). These current upstream pages do not override the installed 18.3.0 behavior.

## Installed-provider loopback acceptance

`pnpm test:providers:installed` runs Codex, Claude, OpenCode and OMP against local HTTP
fixtures with scratch homes and placeholder credentials: Codex through
`scripts/test_codex_loopback.py`, Claude through the worker's `providers/claude/loopback.test.mjs`
and OMP through the worker's `worker-peer.test.mjs` loopback case. OpenCode is a provider plugin: its installed case is
`e2e/protocol/adapters/opencode-native.spec.ts`, which installs the packaged plugin into a
scratch profile and drives the installed OpenCode through the real daemon (see
[the plugin README](../plugins/opencode/README.md)). These checks do not imply hosted
authentication, which remains unverified.
The default run also checks active Codex and Claude turns across three daemon boots.
`pnpm test:providers:handoff` runs that joint check alone. It holds each local HTTP stream open
until the restarted daemon has reported its runtime inventory, then verifies the same agent,
runtime and native thread plus one completed user turn.
Use `--provider codex|claude|opencode|omp` to select one, or `--list` to inspect selection.
The ordinary deterministic gate does not launch these installed-provider checks.

Install workspace dependencies with pnpm. Install the provider executables separately; OMP uses
the workspace package. Codex also needs `pnpm build:backend` to supply debug daemon/runtime
binaries. The debug daemon uses a scratch file secret store. The command checks executables and
workspace dependencies before launching tests; missing prerequisites fail with an explicit
category and leave the selected providers unexecuted.

Each run writes `prerequisites.json`, a stage summary and bounded logs under
`test-results/runs/providers-installed-<id>/`. OMP retains a native JUnit report; the OpenCode
stage writes its Playwright protocol run under `test-results/runs/protocol-<id>/`.
The existing Python Codex/Claude probes retain their command outcomes and JSON assertion
summaries in logs; they do not supply individual native test-case records. Failed assertions
remain failures, and the runner does not retry correctness checks.
