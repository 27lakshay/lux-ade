# Desktop E2E

The built Electron app, unpackaged (`electron apps/desktop`), driven with Playwright against a
scratch daemon and runtime with the provider mocks. It covers the desktop paths the daemon
authority effort changed: window claim, worktree creation with `show_in`, and sending through
the SDK's send journal.

```sh
pnpm test:e2e:desktop         # build backend, SDK, CLI and desktop, then run
pnpm test:e2e:desktop:only    # run without building
pnpm test:e2e:desktop:only e2e/desktop/send.spec.ts
```

- Two workers by default; `ADE_E2E_WORKERS=N` changes it. Each test runs an app, a daemon and a
  runtime.
- `ADE_E2E_KEEP=1` keeps each test's scratch directory after a pass; a failed test keeps it.
- Not part of `pnpm check:static`, which only typechecks and lints this directory.

## Writing a spec

Import `test` and `expect` from `./fixtures`. It is the protocol harness
([e2e/protocol/README.md](../protocol/README.md): `profile`, `repo`, `ade`, the mocks, the rules)
plus `desktop`:

| Fixture or helper | What it gives you |
|---|---|
| `desktop.launch(profile, env?)` | Starts the app on the profile's socket (`ADE_SOCKET`) and returns `{ app, window }`. Windows stay hidden (`ADE_E2E_HIDE_WINDOW=1`), no debugging or state port is opened, and every launch in a test shares one user-data directory, so a relaunch finds the last one's journals. |
| `desktop.quit(running)` | Quits as a person does: windows keep their records. |
| `desktop.kill(running)` | SIGKILL: no quit guard or teardown runs. |
| `windowRecordOf(window)` | The window's daemon record, from its URL (`?window=<ID>`). |

Assert what the window draws (rows, their `data-selected` and `aria-current`, status marks by
their accessible name) and what the daemon holds (`profile.cli`, `profile.call`). Find elements by
role and accessible name; the navigator's list is `getByRole('list', { name: 'Projects' })`.
Never sleep: poll with `expect.poll` or a locator.

The conversation surface is not built yet, so a send calls the bridge the composer will use
(`window.adeHost.conversations.request`) from the window's page, after saving the draft as the
composer does.

## Not covered yet

- **Typing and sending in the composer.** A conversation tab renders nothing yet
  (`renderer/src/features/workspace/content/tab-content.tsx`), so the send specs call the bridge.
  Port them to the composer when it is built.
- **A reply drawn in the transcript.** There is no transcript view; the specs check the
  conversation row's status mark in the navigator and the daemon's messages instead.
- **A window claimed by another client.** `window.claim` has no idea of client ownership, so there
  is nothing to prove; see "Not decided yet" in the
  [daemon authority map](../../.scratch/daemon-authority/README.md).
- **A prompt queued while the daemon is down.** The desktop refuses the send before the journal
  sees it, so the spec proves the refusal and a single send after the restart. The journal path
  is covered separately, by pausing main after the journal holds the prompt.


## Reproduce a failure

Use one file or `--grep` to keep the diagnostic run focused:

```sh
pnpm test:e2e:desktop:only e2e/desktop/send.spec.ts --ui
ADE_DESKTOP_HEADED=1 pnpm test:e2e:desktop:only e2e/desktop/send.spec.ts --workers 1
ADE_DESKTOP_TRACE=retain-on-failure ADE_TEST_HTML=1 pnpm test:e2e:desktop:only e2e/desktop/send.spec.ts --workers 1
pnpm exec playwright show-report test-results/runs/desktop-<run-id>/html
pnpm exec playwright show-trace <attached-electron-trace.zip>
```

The Playwright UI selects and reruns tests. `ADE_DESKTOP_HEADED=1` also shows the app window;
ordinary runs keep it hidden. HTML reporting is opt-in and never opens a browser automatically.
Terminal output and native JSON remain available alongside HTML.

`ADE_DESKTOP_TRACE` accepts `off` (default), `on` (retain every trace), or
`retain-on-failure` (record every launch but retain only failed-test traces). The fixture
starts tracing on the actual Electron context and stops it before quit, kill or teardown.
Each launch has its own archive, so a restart preserves both sides. Traces retained by one
test have a combined 100 MiB limit. Optional HTML reporting copies those attachments again,
so trace storage is bounded by 200 MiB per test when HTML is enabled. Exceeding the limit records a collection error and fails
an otherwise passing diagnostic run; select a narrower test.

Failed tests also retain the protocol fixture's bounded daemon/runtime logs, provider calls,
operation log and scratch-root reference. A trace does not replace backend evidence. In a
crash test, inspect the operation log and native calls as well as the window snapshot.

Recording has a cost even when successful traces are discarded. Stop UI/watch processes and
leave `ADE_DESKTOP_TRACE=off` and `ADE_TEST_HTML` unset for timing comparisons.
See [Playwright tracing](https://playwright.dev/docs/api/class-tracing) and
[UI Mode](https://playwright.dev/docs/test-ui-mode).

## Accessibility acceptance

`accessibility.spec.ts` runs axe once each against the built shell, open command palette and
workspace removal confirmation. It reaches those states through clicks and checks initial
focus, Escape, keyboard cancellation and the workspace remaining in the daemon catalog.
The existing interaction specs continue to run. Conversation content remains unbuilt and has
no accessibility scan yet.

The pinned `@axe-core/playwright` development package uses the same `playwright-core` version
as the desktop runner. Electron rejects the blank page axe normally creates to aggregate
results, so this spec uses [axe's documented legacy mode](https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/README.md#axebuildersetlegacymodelegacymode-boolean--true).
The test requires exactly one frame; it fails instead of silently omitting child-frame coverage.
Every scan runs the default rules without exclusions and attaches raw results, scan duration
and a screenshot to the native report. Failures include rule IDs, affected selectors, HTML and
failure details. A scan waits for the previous menu's exit animation to remove its DOM before
checking the confirmation.

```sh
pnpm test:e2e:desktop:only e2e/desktop/accessibility.spec.ts --workers 1
```

These scans run in the ordinary desktop acceptance command and its CI job. Their reported
scan durations measure added accessibility work; they do not establish a speed improvement
for the existing desktop suite. Automated scans supplement the keyboard and focus assertions.

Axe's `incomplete` results stay in each raw attachment. Current examples are the empty pane's
tab list, Base UI's modal focus guards, shortcut glyph contrast, and the confirmation
description's overlapping background. Tab and Shift+Tab assertions verify focus stays in the
palette or cycles between the confirmation buttons. Those checks supplement the focus-guard
finding; they do not turn unresolved contrast or empty-tab-list findings into automated passes.
A clean violations list is not a complete accessibility audit.
