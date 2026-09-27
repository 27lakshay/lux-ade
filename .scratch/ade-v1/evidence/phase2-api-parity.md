# api-parity

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-5
Worker: Phase 2 parallel build, round E, slice api-parity
Requirements: F101 (complete application command API), F102 (CLI support), F103 (client SDK). None is fully accepted: each still needs its E2E acceptance from the 09-api-orchestration spec.

## Outcome

`@ade/client` has a generic typed `call(endpoint, op, request)` and `AdeClient.call(op, request)`.
The argument and return types come from the generated contracts. The request is validated
before anything is sent, and a failure reports `invalid_request` with delivery `not_sent`. The
reply is validated with `decodeResponse`, and a failure reports `protocol` with delivery
`unknown`, because the request was delivered. `dailyUseCommand` now delegates to `call`. Its
invalid requests now raise `DaemonRequestError` (`invalid_request`, `not_sent`) instead of a bare
`ContractError`. No caller matched on `ContractError`.

The CLI `request OP [JSON]` goes through `call`. It refuses an unknown operation with a usage
error, and it checks both the request and the reply against the contract. The new
`ade operations [DOMAIN]` command lists every operation with its domain and tier, and needs no
daemon. The CLI gained named commands for 30 operations that had none:

- New area modules: `activity`, `notification deliveries`, `attachment`, `file`, `queue`,
  `resources`, `runtime`, `operations` and `request` (`apps/cli/src/commands/{activity,attachments,files,queue,resources,runtime,request}.ts`).
- Existing areas: `conversation disconnect` and `conversation child-transcript`, `terminal restart`,
  `provider list`, `service remove` and `service health`, `git hunk`, `git operations` and
  `git acknowledge`, `worktree refresh`, and `workspace rebind-list` and `repository rebind-list`.
- Five places built operation names from templates (`agent.${action}`, `terminal.${action}`,
  `plugin.${action}`, `plugin.host.${action}`, `hook.delivery.${action}`). They now name each
  operation literally, so the parity gate can see them. Their behaviour is unchanged.

`scripts/api-parity.mjs` is the parity gate, and `check:static` runs it as step `api parity`. It
fails in these cases:

- An operation in `packages/contracts` has no CLI command and no written exemption.
- An operation lacks a generated request or reply validator, so `call` cannot check it.
- CLI code builds an operation name dynamically.
- An operation-position literal (`op: '…'` or a request helper's second argument) names no
  contract operation.
- An exemption is stale or names no operation.
- `@ade/client` depends on or imports React or Electron, or no longer exports `call`.

Result on this branch: 234 operations. 219 have a named CLI command and 15 are exempt, each
with a reason. All 234 are callable through `call`.

## Operation tiers

No operation was added or changed. The new CLI commands call these existing operations:

| Operation | Tier | CLI command |
|---|---|---|
| `activity.list` | query | `activity list` |
| `activity.mark` | idempotent command | `activity mark` |
| `notification.delivery.list` | query | `notification deliveries` |
| `attachment.import` | idempotent command | `attachment import` |
| `attachment.inspect` | query | `attachment inspect` |
| `attachment.reclaim.preview` | query | `attachment reclaim-preview` |
| `attachment.reclaim.apply` | idempotent command | `attachment reclaim` |
| `file.list`, `file.search`, `file.preview` | query | `file list`, `file search`, `file preview` |
| `queue.enqueue` | effect command | `queue add ... --request-id ID` |
| `queue.cancel` | idempotent command | `queue cancel` |
| `queue.pause` | effect command | `queue pause`, `queue resume` |
| `resources.inspect` | query | `resources inspect` |
| `resources.claim.resolve` | effect command | `resources resolve ... --request-id ID` |
| `resources.registry.accept` | effect command | `resources accept-registry ... --request-id ID` |
| `runtime.status` | query | `runtime status` |
| `runtime.prepare_restart` | effect command | `runtime prepare-restart BOOT_ID` |
| `agent.disconnect` | effect command | `conversation disconnect` |
| `agent.child_transcript` | query | `conversation child-transcript` |
| `terminal.restart` | effect command | `terminal restart` |
| `provider.list` | query | `provider list` |
| `service.remove` | effect command | `service remove` |
| `service.health.sample` | query | `service health` |
| `review.hunk` | effect command | `git hunk ... --request-id ID` |
| `review.operation.list` | query | `git operations` |
| `review.operation.acknowledge` | idempotent command | `git acknowledge` |
| `worktree.refresh` | effect command | `worktree refresh ... --request-id ID` |
| `workspace.rebind.list`, `repository.rebind.list` | query | `workspace rebind-list`, `repository rebind-list` |
| `plugin.inspect`, `plugin.enable`, `plugin.disable`, `plugin.host.status`, `plugin.host.restart`, `hook.delivery.inspect`, `hook.delivery.abandon`, `terminal.stop`, `terminal.retire`, `agent.cancel`, `agent.resume` | unchanged | existing commands, now named literally |

## Checks

- `pnpm check:static`: pass, including the new `api parity` step.
- CLI smoke run without a daemon: `operations`, and the usage and exit codes for an unknown
  operation, a contract-invalid `request`, and a missing `--request-id`. A request that passes
  validation reaches the socket and exits `unavailable`.
- In-process tests added: `packages/client/src/call.test.mjs` (request encoding, `not_sent`
  and `unknown` delivery, a validator for every operation) and `scripts/api-parity.test.mjs`
  (the parity decision and the SDK independence check). `check:static` now also runs
  `scripts/*.test.mjs`.

Verified only statically: the new CLI commands are typechecked against the generated
contracts, and `call` validates their replies at run time. None of them has run against a real
daemon in this slice.

Needs E2E later:

- F101: agents and the UI apply the same authority and lifecycle rules through one interface.
- F102: each new command against a real profile daemon, including GUI-created work and the exit
  codes for `outcome_unknown` and `not_applied`.
- F103: a headless consumer using `call` and the feed without React or Electron.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 5 | 10 | 0 |

## References

- opencode-v2 @ ade-evaluation-2026-09-24, `packages/client/test/contract-identity.test.ts`,
  `packages/httpapi-codegen/README.md`: pattern. The client exposes the canonical generated
  contracts, uses one stable client error, and a check fails on drift. No code copied.

## Open

- Coverage means an operation name appears literally in a CLI source outside the generic
  `request` module. A mention only in a type position counts. The gate does not prove that
  the command dispatches the operation.
- `queue add` sends text only. Queued attachments (`attachments` in `queue.enqueue`) are
  reachable only through `ade request`.
- `session.subscribe` has no streaming CLI command. `ade request session.subscribe` returns the
  first catalog frame only.
- `agent.list` and `agent.account_inspect` are runtime-socket operations. They are typed in the SDK,
  but `call` sends to the profile command socket, which does not serve them.
- Most older CLI commands still use `requestDaemon` without reply validation, for example
  `conversation send`, `conversation cancel` and `status`. Moving them to `call` would validate
  their replies too. That changes an invalid reply into a `protocol` exit and needs E2E cover.
- Coordinator: no shared-file changes needed. `scripts/check-static.mjs` gained the `api parity`
  step and the `scripts/*.test.mjs` test glob.

## Parity table

Generated by `node scripts/api-parity.mjs --table`. CLI names the module that exposes the
operation.

| Operation | Domain | Tier | CLI | SDK `call` |
|---|---|---|---|---|
| `account.create` | accounts | effect_command | accounts.ts | yes |
| `account.disable` | accounts | idempotent_command | accounts.ts | yes |
| `account.inspect` | accounts | query | accounts.ts | yes |
| `account.list` | accounts | query | accounts.ts | yes |
| `account.verify` | accounts | idempotent_command | accounts.ts | yes |
| `activity.list` | activity | query | activity.ts | yes |
| `activity.mark` | activity | idempotent_command | activity.ts | yes |
| `adapter.list` | providers | query | adapters.ts | yes |
| `adapter.probe` | providers | idempotent_command | adapters.ts | yes |
| `adapter.put` | providers | idempotent_command | adapters.ts | yes |
| `adapter.remove` | providers | idempotent_command | adapters.ts | yes |
| `agent.account_inspect` | agents | query | exempt: Runtime socket only, with the daemon owner token; not served on the profile command socket | yes |
| `agent.answer` | conversations | effect_command | conversations.ts | yes |
| `agent.cancel` | agents | effect_command | conversations.ts | yes |
| `agent.child_transcript` | agents | query | conversations.ts | yes |
| `agent.disconnect` | agents | effect_command | conversations.ts | yes |
| `agent.list` | agents | query | exempt: Runtime socket only, with the daemon owner token; not served on the profile command socket | yes |
| `agent.resume` | agents | effect_command | conversations.ts | yes |
| `agent.send` | conversations | effect_command | conversations.ts | yes |
| `agent.send_review` | agents | effect_command | git.ts | yes |
| `attachment.import` | conversations | idempotent_command | attachments.ts | yes |
| `attachment.inspect` | conversations | query | attachments.ts | yes |
| `attachment.put` | conversations | idempotent_command | exempt: Carries base64 bytes for clients on another host; the local CLI uses `attachment import` | yes |
| `attachment.reclaim.apply` | conversations | idempotent_command | attachments.ts | yes |
| `attachment.reclaim.preview` | conversations | query | attachments.ts | yes |
| `browser.close` | daemon | effect_command | browser.ts | yes |
| `browser.context.capture` | browser | idempotent_command | browser-context.ts | yes |
| `browser.diagnostics.attach` | browser | idempotent_command | browser-diagnostics.ts | yes |
| `browser.diagnostics.detach` | browser | idempotent_command | browser-diagnostics.ts | yes |
| `browser.diagnostics.read` | browser | query | browser-diagnostics.ts | yes |
| `browser.import.get` | browser | query | browser-context.ts | yes |
| `browser.import.preview` | browser | query | browser-context.ts | yes |
| `browser.import.run` | browser | idempotent_command | browser-context.ts | yes |
| `browser.inspect` | daemon | query | browser.ts | yes |
| `browser.list` | daemon | query | browser.ts | yes |
| `browser.navigate` | daemon | effect_command | browser.ts | yes |
| `browser.open` | daemon | effect_command | browser.ts | yes |
| `browser.operation` | daemon | query | browser.ts | yes |
| `browser.owner.get` | daemon | query | browser.ts | yes |
| `browser.owner.register` | daemon | idempotent_command | exempt: Only the Electron main process registers itself as the browser owner | yes |
| `browser.owner.unregister` | daemon | idempotent_command | exempt: Only the Electron main process unregisters itself as the browser owner | yes |
| `browser.partition.create` | browser | idempotent_command | browser-context.ts | yes |
| `browser.partition.list` | browser | query | browser-context.ts | yes |
| `browser.recording.get` | browser | query | browser-diagnostics.ts | yes |
| `browser.recording.start` | browser | idempotent_command | browser-diagnostics.ts | yes |
| `browser.recording.stop` | browser | idempotent_command | browser-diagnostics.ts | yes |
| `catalog.get` | workspaces | query | runs.ts, shared.ts | yes |
| `checkpoint.create` | checkpoints | effect_command | checkpoints.ts | yes |
| `checkpoint.delete` | checkpoints | effect_command | checkpoints.ts | yes |
| `checkpoint.list` | checkpoints | query | checkpoints.ts | yes |
| `checkpoint.restore` | checkpoints | effect_command | checkpoints.ts | yes |
| `checkpoint.restore.preview` | checkpoints | query | checkpoints.ts | yes |
| `conversation.compact` | conversations | effect_command | conversation-controls.ts | yes |
| `conversation.controls` | conversations | query | conversation-controls.ts | yes |
| `conversation.create` | conversations | effect_command | conversations.ts | yes |
| `conversation.get` | conversations | query | conversations.ts | yes |
| `conversation.rewind` | conversations | effect_command | conversation-controls.ts | yes |
| `conversation.rewind.preview` | conversations | query | conversation-controls.ts | yes |
| `conversation.snooze` | conversations | idempotent_command | conversation-controls.ts | yes |
| `conversation.snooze.list` | conversations | query | conversation-controls.ts | yes |
| `conversation.steer` | conversations | effect_command | conversation-controls.ts | yes |
| `conversation.unsnooze` | conversations | idempotent_command | conversation-controls.ts | yes |
| `device.app.install` | devices | effect_command | devices.ts | yes |
| `device.app.launch` | devices | effect_command | devices.ts | yes |
| `device.boot` | devices | effect_command | devices.ts | yes |
| `device.list` | devices | query | devices.ts | yes |
| `device.screenshot` | devices | query | devices.ts | yes |
| `diagnostics.export` | daemon | query | diagnostics.ts | yes |
| `diagnostics.status` | daemon | query | diagnostics.ts | yes |
| `draft.get` | conversations | query | git.ts | yes |
| `draft.save` | conversations | idempotent_command | git.ts | yes |
| `draft.send.abort` | conversations | idempotent_command | exempt: Desktop window send-intent recovery | yes |
| `draft.send.acknowledge` | conversations | idempotent_command | exempt: Desktop window send-intent recovery | yes |
| `draft.send.complete` | conversations | idempotent_command | git.ts | yes |
| `draft.send.get` | conversations | query | exempt: Desktop window send-intent recovery; `git feedback-send` completes its own intent in one command | yes |
| `draft.send.list` | conversations | query | exempt: Desktop window send-intent recovery | yes |
| `draft.send.prepare` | conversations | idempotent_command | git.ts | yes |
| `file.list` | files | query | files.ts | yes |
| `file.preview` | files | query | files.ts | yes |
| `file.search` | files | query | files.ts | yes |
| `hello` | daemon | query | remote-connect.ts, index.ts | yes |
| `history.import.scan` | history | query | imports.ts | yes |
| `history.import.session` | history | idempotent_command | imports.ts | yes |
| `history.index.rebuild` | history | idempotent_command | history.ts | yes |
| `history.index.status` | history | query | history.ts | yes |
| `history.list` | history | query | history.ts | yes |
| `history.search` | history | query | history.ts | yes |
| `hook.delivery.abandon` | hooks | idempotent_command | hooks.ts | yes |
| `hook.delivery.inspect` | hooks | query | hooks.ts | yes |
| `hook.delivery.list` | hooks | query | hooks.ts | yes |
| `hook.delivery.retry` | hooks | effect_command | hooks.ts | yes |
| `hook.subscription.list` | hooks | query | hooks.ts | yes |
| `listener.list` | services | query | services.ts | yes |
| `mcp.resolve` | mcp | query | mcp.ts | yes |
| `mcp.server.add` | mcp | idempotent_command | mcp.ts | yes |
| `mcp.server.inspect` | mcp | query | mcp.ts | yes |
| `mcp.server.list` | mcp | query | mcp.ts | yes |
| `mcp.server.remove` | mcp | idempotent_command | mcp.ts | yes |
| `mcp.server.update` | mcp | idempotent_command | mcp.ts | yes |
| `notification.delivery.claim` | activity | idempotent_command | exempt: Called by a notification-showing client (the desktop) for its own delivery channel | yes |
| `notification.delivery.list` | activity | query | activity.ts | yes |
| `notification.delivery.report` | activity | idempotent_command | exempt: Called by a notification-showing client (the desktop) for its own delivery channel | yes |
| `orchestration.child.get` | orchestration | query | orchestration.ts | yes |
| `orchestration.child.send` | orchestration | effect_command | orchestration.ts | yes |
| `orchestration.child.wait` | orchestration | query | orchestration.ts | yes |
| `orchestration.children` | orchestration | query | orchestration.ts | yes |
| `orchestration.delegate` | orchestration | effect_command | orchestration.ts | yes |
| `orchestration.group.compare` | orchestration | query | runs.ts | yes |
| `orchestration.group.get` | orchestration | query | runs.ts | yes |
| `orchestration.group.start` | orchestration | effect_command | runs.ts | yes |
| `orchestration.groups` | orchestration | query | runs.ts | yes |
| `placement.check` | placement | query | placement.ts | yes |
| `placement.hosts` | placement | query | placement.ts | yes |
| `placement.list` | placement | query | placement.ts | yes |
| `placement.record` | placement | idempotent_command | placement.ts | yes |
| `placement.release` | placement | idempotent_command | placement.ts | yes |
| `placement.resolve` | placement | query | placement.ts | yes |
| `plugin.command.invoke` | plugins | effect_command | plugins.ts | yes |
| `plugin.disable` | plugins | idempotent_command | plugins.ts | yes |
| `plugin.enable` | plugins | idempotent_command | plugins.ts | yes |
| `plugin.host.restart` | plugins | idempotent_command | plugins.ts | yes |
| `plugin.host.status` | plugins | query | plugins.ts | yes |
| `plugin.inspect` | plugins | query | plugins.ts | yes |
| `plugin.install` | plugins | effect_command | plugins.ts | yes |
| `plugin.list` | plugins | query | plugins.ts | yes |
| `plugin.record.delete` | plugins | idempotent_command | plugins.ts | yes |
| `plugin.record.get` | plugins | query | plugins.ts | yes |
| `plugin.record.list` | plugins | query | plugins.ts | yes |
| `plugin.record.put` | plugins | idempotent_command | plugins.ts | yes |
| `plugin.setting.list` | plugins | query | plugins.ts | yes |
| `plugin.setting.set` | plugins | idempotent_command | plugins.ts | yes |
| `plugin.uninstall` | plugins | effect_command | plugins.ts | yes |
| `preset.delete` | providers | idempotent_command | providers.ts | yes |
| `preset.get` | providers | query | providers.ts | yes |
| `preset.list` | providers | query | providers.ts | yes |
| `preset.save` | providers | idempotent_command | providers.ts | yes |
| `provider.capabilities` | providers | query | providers.ts | yes |
| `provider.list` | accounts | query | providers.ts | yes |
| `provider.quota` | providers | query | providers.ts | yes |
| `provider.readiness` | providers | query | providers.ts | yes |
| `queue.cancel` | conversations | idempotent_command | queue.ts | yes |
| `queue.enqueue` | conversations | effect_command | queue.ts | yes |
| `queue.pause` | conversations | effect_command | queue.ts | yes |
| `remote.host.add` | remote | idempotent_command | remote.ts | yes |
| `remote.host.list` | remote | query | placement.ts, remote.ts | yes |
| `remote.host.pair` | remote | idempotent_command | remote.ts | yes |
| `remote.host.probe` | remote | query | remote.ts | yes |
| `remote.host.remove` | remote | idempotent_command | remote.ts | yes |
| `remote.host.revoke` | remote | idempotent_command | remote.ts | yes |
| `remote.host.start` | remote | effect_command | remote.ts | yes |
| `repository.clone` | repository | effect_command | repository.ts | yes |
| `repository.coverage` | repository | query | repository.ts | yes |
| `repository.publish` | repository | effect_command | repository.ts | yes |
| `repository.publish.preview` | repository | query | repository.ts | yes |
| `repository.rebind` | workspaces | idempotent_command | workspaces.ts | yes |
| `repository.rebind.list` | workspaces | query | workspaces.ts | yes |
| `resources.claim.resolve` | resources | effect_command | resources.ts | yes |
| `resources.inspect` | resources | query | resources.ts | yes |
| `resources.registry.accept` | resources | effect_command | resources.ts | yes |
| `retention.apply` | retention | idempotent_command | retention.ts | yes |
| `retention.preview` | retention | query | retention.ts | yes |
| `review.commit` | review | effect_command | git.ts | yes |
| `review.diff` | review | query | git.ts | yes |
| `review.diff_page` | review | query | git.ts | yes |
| `review.discard` | review | effect_command | git.ts | yes |
| `review.feedback.search` | review | query | git.ts | yes |
| `review.hunk` | review | effect_command | git.ts | yes |
| `review.operation` | review | query | git.ts | yes |
| `review.operation.acknowledge` | review | idempotent_command | git.ts | yes |
| `review.operation.list` | review | query | git.ts | yes |
| `review.stage` | review | effect_command | git.ts | yes |
| `review.status` | review | query | git.ts | yes |
| `review.unstage` | review | effect_command | git.ts | yes |
| `runtime.prepare_restart` | daemon | effect_command | runtime.ts | yes |
| `runtime.status` | daemon | query | runtime.ts | yes |
| `script.inspect` | scripts | query | services.ts | yes |
| `script.list` | scripts | query | services.ts | yes |
| `script.retire` | scripts | effect_command | services.ts | yes |
| `script.runs` | scripts | query | services.ts | yes |
| `script.start` | scripts | effect_command | services.ts | yes |
| `script.stop` | scripts | effect_command | services.ts | yes |
| `service.configure` | services | idempotent_command | services.ts | yes |
| `service.health.sample` | services | query | services.ts | yes |
| `service.inspect` | services | query | services.ts | yes |
| `service.list` | services | query | services.ts | yes |
| `service.proxy.ensure` | services | idempotent_command | services.ts | yes |
| `service.proxy.inspect` | services | query | services.ts | yes |
| `service.proxy.recovery.inspect` | services | query | services.ts | yes |
| `service.proxy.recovery.reset` | services | effect_command | services.ts | yes |
| `service.proxy.recovery.retry` | services | effect_command | services.ts | yes |
| `service.proxy.remap` | services | effect_command | services.ts | yes |
| `service.proxy.retire` | services | effect_command | services.ts | yes |
| `service.proxy.target` | services | query | exempt: Asked by the runtime proxy before it forwards one connection | yes |
| `service.remove` | services | effect_command | services.ts | yes |
| `service.start` | services | effect_command | services.ts | yes |
| `service.stop` | services | effect_command | services.ts | yes |
| `session.subscribe` | daemon | query | exempt: A stream: `ade request` returns its first catalog frame; AdeClient.subscribeFeed follows the feed | yes |
| `skill.adopt` | skills | effect_command | skills.ts | yes |
| `skill.discover` | skills | idempotent_command | skills.ts | yes |
| `skill.inspect` | skills | query | skills.ts | yes |
| `skill.install` | skills | effect_command | skills.ts | yes |
| `skill.list` | skills | query | skills.ts | yes |
| `skill.remove` | skills | effect_command | skills.ts | yes |
| `terminal.create` | terminals | effect_command | terminals.ts | yes |
| `terminal.operation` | terminals | query | terminals.ts | yes |
| `terminal.restart` | terminals | effect_command | terminals.ts | yes |
| `terminal.retire` | terminals | effect_command | terminals.ts | yes |
| `terminal.stop` | terminals | effect_command | terminals.ts | yes |
| `usage.limits` | usage | query | usage.ts | yes |
| `usage.summary` | usage | query | usage.ts | yes |
| `usage.turns` | usage | query | usage.ts | yes |
| `window.close` | conversations | idempotent_command | exempt: Desktop window state | yes |
| `window.save` | conversations | idempotent_command | exempt: Desktop window state | yes |
| `workspace.open` | workspaces | idempotent_command | orchestration.ts, workspaces.ts | yes |
| `workspace.rebind` | workspaces | idempotent_command | workspaces.ts | yes |
| `workspace.rebind.list` | workspaces | query | workspaces.ts | yes |
| `worktree.adopt` | worktrees | effect_command | workspaces.ts | yes |
| `worktree.archived` | worktrees | query | worktrees.ts | yes |
| `worktree.carry` | worktrees | effect_command | worktrees.ts | yes |
| `worktree.carry.preview` | worktrees | query | worktrees.ts | yes |
| `worktree.cleanup` | worktrees | effect_command | worktrees.ts | yes |
| `worktree.cleanup.plan` | worktrees | query | worktrees.ts | yes |
| `worktree.configure` | worktrees | idempotent_command | worktrees.ts | yes |
| `worktree.create` | worktrees | effect_command | worktrees.ts | yes |
| `worktree.get` | worktrees | query | workspaces.ts | yes |
| `worktree.operation` | worktrees | query | orchestration.ts, workspaces.ts | yes |
| `worktree.rebind` | worktrees | idempotent_command | workspaces.ts | yes |
| `worktree.rebind.list` | worktrees | query | workspaces.ts | yes |
| `worktree.refresh` | worktrees | effect_command | workspaces.ts | yes |
| `worktree.remove` | worktrees | effect_command | workspaces.ts | yes |
| `worktree.repository` | worktrees | idempotent_command | workspaces.ts | yes |
| `worktree.resources.apply` | worktrees | effect_command | worktrees.ts | yes |
| `worktree.setup` | worktrees | effect_command | worktrees.ts | yes |
| `worktree.switch` | worktrees | effect_command | orchestration.ts, workspaces.ts | yes |
