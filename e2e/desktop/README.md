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
