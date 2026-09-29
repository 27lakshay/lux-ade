# Protocol E2E

Headless backend E2E. Each test drives a real `ade-daemon` and `ade-runtime`
through the SDK, the CLI or the raw protocol. Electron is not involved.

```sh
pnpm test:e2e:protocol         # build backend, SDK and CLI, then run
pnpm test:e2e:protocol:only    # run without building
pnpm test:e2e:protocol:only boot --grep "restart"
```

- `ADE_E2E_WORKERS=N` sets the worker count. It defaults to half the CPUs, which is right for one
  suite running alone: the tests mostly wait on real processes, so more workers cut the time almost
  in proportion. Lower it only when several suites run at once on the machine (for example
  parallel worktrees: 2 each).
- Each run ends with the slowest spec files (over 10 s); start there when the suite gets slow.
- `pnpm test:e2e:protocol:faults` builds, then runs the fault conformance
  suite; `pnpm test:e2e:protocol:faults:only` runs it without building. See
  [Fault conformance suite](#fault-conformance-suite).
- Tests in a file run in parallel. There are no retries, so the first failure
  is the one reported.
- `ADE_E2E_KEEP=1` keeps each test's scratch directory after a pass. A failed
  test always keeps it and prints its path.
- `pnpm typecheck` (part of `pnpm check:static`) typechecks this directory.

## Writing a spec

Put `<area>.spec.ts` in this directory. Import `test` and `expect` from
`./fixtures`, not from `@playwright/test`; only that `test` runs the cleanup.

```ts
import { expect, prompts, send, startConversation, test, waitForMessage } from './fixtures'

test('a Codex turn reaches the transcript', async ({ profile, repo }) => {
  const { conversationId } = await startConversation(profile, 'codex', repo.path)
  await send(profile, conversationId, prompts.turn)
  await waitForMessage(profile, conversationId, 'Hello world')
})
```

| Fixture or helper | What it gives you |
|---|---|
| `profile` | A started scratch profile: a daemon and its runtime on unique temp paths, with a scratch `HOME` and both provider mocks. It starts on first use. |
| `repo` | A scratch Git repository with one commit on `main`. |
| `ade` | The test's harness. `ade.profile()` starts another profile. `ade.repo({ name })` creates another repository. |
| `profile.call(op, request)` | The SDK's `call()`. It checks the request against `@ade/contracts` before sending and validates the reply. The reply is typed. |
| `profile.rpc(request)` | One raw protocol line with no contract check. Use it for `hello`, `runtime.*` and malformed-input tests. |
| `profile.cli(...args)` | The built `ade` CLI with `--socket`. It returns `{ code, json, stdout, stderr }` and never throws on a non-zero exit. |
| `profile.killDaemon()` | Sends SIGKILL to the daemon. The runtime keeps running. |
| `profile.killRuntime()` | Sends SIGKILL to the runtime. The daemon keeps running and still reports the dead runtime. |
| `profile.restartDaemon(mode)` | Starts a new daemon on the same data directory and returns its `hello`. `'graceful'` (default) hands the runtime over. `'kill'` sends SIGKILL first. After `killRuntime`, the new daemon starts a new runtime. |
| `profile.hello` | The running daemon's `hello`: `pid`, `boot_id`, `runtime_pid`, `runtime_instance`. |
| `repo.commit`, `repo.commitAll`, `repo.dirty`, `repo.stagedAndUnstaged`, `repo.status`, `repo.git` | Git states for review, discard and worktree tests. |
| `prompts`, `codexPrompts`, `turnReply` | Prompts that script the mock providers: a turn, an approval, questions, a held turn. |
| `startConversation`, `send`, `waitForIdle`, `waitForMessage`, `waitForPendingRequest`, `fixtureAnswers` | Conversation steps over the SDK. |
| `profile.mockCalls(provider)`, `profile.releaseMock(provider, file)` | Reads what a mock received. Creates the file a scripted mock waits for. |
| `isRunning(pid)` | Process liveness. It treats an unreaped zombie as exited. |
| `profile.secrets` | The profile's test-only secret store (`fixtures/secret-store.ts`), an encrypted file in the scratch HOME. `scratchEnvironment` sets `ADE_SECRET_STORE=file` for every process a spec starts, so no daemon reaches the Keychain. `add`, `find`, `delete` and `accounts` act on items as a user would on their Keychain; `raw()` gives the file's bytes for at-rest checks. Pointing `profile.env.ADE_SECRET_FILE` into a missing directory makes the store unavailable. |
| `fixtures/devices`: `DeviceHost` | PATH and SDK-root shims for `xcrun simctl`, `idb`, `adb`, `emulator` and `aapt2` over one `state.json`, with holds that pause an effect and a record of every effect, input included. |
| `fixtures/browser-owner`: `startBrowserOwner` | A scripted browser owner on a private socket; `register()` registers it again, as the desktop owner does after a new daemon `boot_id`. |
| `fixtures/faulty-plugin`: `stageFaultyPlugin`, `breakActivation`, `healActivation` | A backend plugin whose activation throws, exits or hangs while a switch file exists, with commands that freeze its host and flood its log. |

The provider mocks are `scripts/fixtures/codex_mock.py` and
`scripts/fixtures/claude_mock.mjs`, which serves `providers/claude/fake-sdk.mjs`.
Read them for the complete list of scripted prompts. Neither mock calls a model.

## Rules

**Never sleep.** Do not wait a fixed time for something to happen. Observe it
through the protocol instead: `expect.poll` on a query, `waitFor*` helpers, a
`hello` that reports a new `boot_id`. A mock that must pause waits on a release
file, which you create with `profile.releaseMock`.

**Clean up everything you start.** The harness stops every profile after each
test. It then fails the test if any process it owns is still running. Owned
processes are the daemons, their runtimes, and every child those started, such
as provider mocks and shells. A survivor is killed, and the test still fails.
If a spec starts a process itself, call `ade.ledger.own(pid, role)` so the same
check covers it. Specs need no `finally` cleanup. A spec may call
`profile.stop()` to assert on shutdown itself.

**Never touch real user profiles or accounts.** Every profile process runs with
a scratch `HOME`, `ADE_PROFILES_HOME`, data directory and sockets under the
test's temp root. Inherited `ADE_*`, `CODEX_*`, `CLAUDE_*`, `ANTHROPIC_*`,
`OPENAI_*`, `OMP_*` and `GIT_*` variables are removed. Do not pass real
credentials, real provider binaries, `~/Library` paths or the user's
repositories to a profile. Use mocks and scratch repositories only.

**Keep tests independent.** Tests run in parallel in any order. Do not share
state between tests through files, ports or module variables.

## Fault conformance suite

F140 asks for the fault matrix to run as one named suite through public
interfaces. `pnpm test:e2e:protocol:faults` is that suite. It runs, across
every area, each test that injects a fault: daemon or runtime kills and
restarts, crashed, hung or frozen processes, lost replies and unknown
outcomes, duplicate and conflicting requests, races for a resource, revoked
or disconnected targets, and corrupt input.

The suite is `playwright.faults.config.ts`: the protocol configuration with a
`grep` from [`fault-suite.ts`](fault-suite.ts). A test joins it when its file
path or title names a fault from that vocabulary, such as "crash", "restart",
"unknown", "conflict" or "race", or when its title carries the `@fault` tag.
There is no list of files to keep in step. When you write a fault test,
name the fault in its title; add `@fault` only when no word from the
vocabulary fits. To see what the suite runs:

```sh
pnpm exec playwright test --config playwright.faults.config.ts --list
```

It takes the same arguments as `test:e2e:protocol:only`, such as a path or
`--grep`, and the same `ADE_E2E_WORKERS`.

`fault-suite.ts` also maps every fault class of section 12 of the proposed
architecture to the tests that inject it (`faultClasses`). A test named there
joins the suite even when its title uses no word from the vocabulary.
`load/fault-classes.spec.ts` lists the suite and fails when a mapped test is
renamed, deleted or dropped from it; a fault that no protocol E2E test can
inject yet carries a `gap` and shows as a `fixme`. When you rename a mapped
test, update its entry.

## Load run

`load/load.spec.ts` (tagged `@load`) is the R019 load fixture: 10 agents,
20 terminals, 3 services, 5 browser tabs behind a scripted owner, 10,000
imported history messages, a 5000-line diff and a slow subscriber, through
sustained, idle and daemon-crash phases. It asserts the provisional 250 ms
p95 command admission and records echo, CPU, memory, queues and recovery
time. It is heavy and measures latency, so it is left out of the fault suite.
Run it alone:

    ADE_E2E_WORKERS=1 ADE_E2E_LOAD_RESULTS=/tmp/load.json pnpm test:e2e:protocol:only load/load.spec.ts

`fixtures/load.ts` has the workload and `AdmissionClient`, which times SDK
calls on a worker thread so the test's own terminal parsing is not counted.

## When a test fails

The failing test keeps its temp root and attaches:

- `operations.jsonl`: every SDK, raw protocol and CLI call, with its request and
  a reply summary (type, `request_id`, `operation_id`, receipt, error). It also
  records fixture events such as kills and restarts.
- `daemon-N.stderr` for each daemon launch.
- `daemon.log` and `runtime.log`.
- The mock providers' `calls.jsonl`.
- `owned-processes.json`.

## Machine safety

Never call the macOS Security framework or the `security` tool, create
keychains, or touch the login keychain from a spec or fixture. Secret storage is
tested through the test-only file backend (`ADE_SECRET_STORE=file`, set by
`scratchEnvironment`); `ScratchProfile` refuses to launch a daemon without it.
A release daemon refuses that setting, so the file backend never ships. Specs that use other system services
(the `volume` fixture uses `hdiutil`) skip unless `ADE_E2E_SYSTEM=1`. Run those
alone:

    ADE_E2E_SYSTEM=1 ADE_E2E_WORKERS=1 pnpm test:e2e:protocol:only <spec>

