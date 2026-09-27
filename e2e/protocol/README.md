# Protocol E2E

Headless backend E2E. Each test drives a real `ade-daemon` and `ade-runtime`
through the SDK, the CLI or the raw protocol. Electron is not involved.

```sh
pnpm test:e2e:protocol         # build backend, SDK and CLI, then run
pnpm test:e2e:protocol:only    # run without building
pnpm test:e2e:protocol:only boot --grep "restart"
```

- `ADE_E2E_WORKERS=N` sets the worker count. It defaults to half the CPUs.
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
| `test.use({ keychain: true })`, `profile.keychain` | A scratch macOS keychain per profile, made with `security create-keychain` inside the scratch `HOME` (`fixtures/keychain.ts`). Every daemon gets `ADE_KEYCHAIN` naming that path, so ADE never reaches the user's login keychain; without the option the file does not exist and every keychain call fails. `add(service, account, value, readers)` adds an item as a user would and trusts `readers`; `accounts(service)` lists items without reading values. Items the daemon made are readable only by the daemon. Every keychain call goes through the machine's one `securityd`, so opt in only in specs that store secrets. |

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

## When a test fails

The failing test keeps its temp root and attaches:

- `operations.jsonl`: every SDK, raw protocol and CLI call, with its request and
  a reply summary (type, `request_id`, `operation_id`, receipt, error). It also
  records fixture events such as kills and restarts.
- `daemon-N.stderr` for each daemon launch.
- `daemon.log` and `runtime.log`.
- The mock providers' `calls.jsonl`.
- `owned-processes.json`.
