# Provider worker protocol, version 1

A plugin adds an agent provider by declaring `entry_points.provider` in
`ade-plugin.json`. ADE runs that file as a provider worker: a Node process that
the runtime supervisor starts for one agent run and stops when the run ends.
The worker speaks JSON-RPC 2.0, one message per line, on stdin and stdout.
Anything on stderr is diagnostic output.

The code is `crates/ade-runtime/src/provider_worker.rs`. Where this page and
the code disagree, the code wins.

## Identity and leases

- The provider ID is `plugin:<plugin id>`, such as `plugin:acme.agent`. A
  plugin cannot register a bundled ID (`claude`, `codex`, `omp`, `opencode`)
  or an `adapter:` ID.
- A run is pinned to one installed artifact: plugin ID, version and artifact
  digest. Installing a newer version serves new sessions only. A session that
  started on the old version stays on it while that artifact is installed, and
  is refused, not moved, once it is gone.
- The worker starts with its working directory set to the workspace root and
  with `ADE_PROVIDER_ID`, `ADE_PLUGIN_ID` and `ADE_PLUGIN_VERSION` in its
  environment. `ADE_NODE_BIN` chooses the Node executable.
- ADE does not pass account credentials to a worker. The worker uses its
  agent's own login.

## Requests from ADE

| Method | Params | Result |
|---|---|---|
| `initialize` | `versions` (supported protocol versions), `provider`, `plugin` (`id`, `version`) | `protocol_version`, `name`, `capabilities`, `permission_modes` |
| `open` | `resume` (a native session ID or null), `config` (`model`, `permission_mode`, `setting_sources`) | `session`, `history` (items) |
| `send` | `session`, `submission`, `message_id`, `text`, `attachments` | `turn` |
| `steer` | `session`, `turn`, `message_id`, `text`, `attachments` | `turn` |
| `cancel` | `session`, `turn` | any |
| `answer` | `id` (the request ID from a `request` event), `decision` (`accept`, `decline` or `answer`), `answers` or `reason` | any |

`initialize` must answer within 15 seconds; other requests within 45 seconds.
An error reply fails the call. ADE shows the user a sanitized reason, never the
raw error text.

### The handshake

- `protocol_version` must be one of the offered `versions`. Version 1 is the
  only one.
- `name` is 1 to 80 printable characters.
- `capabilities` may contain `streaming`, `images`, `text_attachments`,
  `resume`, `cancel`, `steering`, `tool_approval` and `questions`. ADE ignores
  names it does not know and never treats them as supported.
- `permission_modes` starts with `default` and lists at most 16 distinct names
  of letters, digits, `-` and `_`.

ADE refuses a launch whose configuration the handshake does not allow. It sends
`open` with a `resume` handle only if the worker declared `resume`, `steer`
only if it declared `steering`, and `cancel` only if it declared `cancel`.

### History items

`open` returns the session's history as items with `id`, `turn`, `role`,
`kind`, `text`, `status` and optional `client_id` and `content`. `id` is the
native item ID and stays attached to the item as provenance. ADE refuses the
whole history if an item has no `id`, repeats one, or has a `role`, `kind` or
`status` that is not a short name.

A `resume` must return the same `session` ID it was given. ADE refuses a
different one, and keeps the original identity.

## Notifications from the worker

The worker reports progress with `event` notifications whose params are one
event: `submitted`, `started`, `item`, `delta`, `request`, `resolved`,
`finished`, `usage`, `operation_failed`, `error` or `exited`. The shapes are
the `Event` enum in `crates/ade-core/src/provider.rs`.

ADE records the user's prompt itself, under the `submission` ID of the `send`
that carried it, and may pre-assign the prompt's native item ID as the send's
`message_id`. A worker that also reports that prompt as an `item` gives it role
`user` and kind `text`, sets its `client_id` to that `submission` and, when
`message_id` is present, its `id` to that `message_id`. ADE then updates its
own record instead of adding a second copy. A different `id`, role or kind for
the same record is refused as a changed message identity, and the run fails.

A worker must not send requests to ADE. A request, a malformed line or a line
over 16 MiB closes the connection, and the run ends with an exit event.

## Failure

A worker that exits or breaks the protocol ends its run. ADE does not restart
it and does not resend the turn in flight, because the worker may already have
acted on it. The user resumes explicitly.
