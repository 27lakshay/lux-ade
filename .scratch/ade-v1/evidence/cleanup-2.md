# Cleanup 2: daemon authority backend finish

Status: built. Branch `claude/agent-ac57f066d15c5ae19`, rebased once on `main` at `b544013`.

## Results

| Check | Result |
|---|---|
| `pnpm check:static` on `bc062a7` (after the rebase) | passed; 865 Rust tests passed, 1 skipped |
| Full `pnpm test:e2e:protocol:only`, 6 workers, on `bc062a7` | 964 passed, 1 failed, 15 skipped (6.1 min) |
| `services/script-runs.spec.ts:246` (pnpm, Bun and Yarn versions) | failed at 6 workers with "Project pnpm executable is unavailable or its version differs"; passed 3 of 3 alone: load (the version probe under contention), not a regression here; the spec touches no changed code |

## Commits

| Hash | What |
|---|---|
| `d787b42` | `backup/rebind.spec.ts`: the two pre-existing failures were a stale spec |
| `9aabe17` | `operation_id` is the only name for the operation ID; no `request_id` alias |
| `27583e2` | Old-data conversions removed (D19) |
| `fe9bf39` | Unknown provider refused as `provider_not_found` (CLI exit 31) |
| `bc062a7` | Keybindings in the profile settings (F015) |

## 1. Rebind failures: the spec was stale

`rebind.spec.ts:228` and `:294` expected `worktree.rebind` to a saved source folder to be
refused with the profile store's message ("belongs to a saved source workspace or
repository"). Since `a7ed41d` (lifecycle registration left the catalog), a repository only
the worktree lifecycle registered has no catalog path binding, so the store's check has
nothing to match. The lifecycle's own identity check still refuses the rebind ("Select a
different physical repository from the saved checkout"). The refusal is correct; the spec now
expects the lifecycle's message. The store's check also covers ancestors of a saved source;
the lifecycle's compares the checkout and common directory only. No spec covers a lifecycle
rebind into a folder inside a saved source.

## 2a. `request_id` as another name for `operation_id`

Removed: every `#[serde(alias = "request_id")]` (Git review mutations, worktree lifecycle
commands, `terminal.create`, `terminal.operation`, `browser.open|navigate|close|operation`,
`browser.click|type`) and the daemon's `browser_request_id` fallback. Renamed to
`operation_id`, because they carry the operation ID under its older name:

- the `terminal.operation` reply field;
- the `browser_mutation` and `browser_operation` replies;
- the daemon-to-owner browser protocol (what the daemon sends the owner and what the owner
  echoes). The desktop's Electron browser owner (`browser-owner.ts`, `browser.ts`,
  `browser-automation.ts`) now reads and echoes `operation_id`; only the field name changed.

Refusal wording now says `operation_id` and "operation ID" (review, worktree, terminal,
browser).

Kept, because each is its own ID and not a second name for `operation_id`:

| Field | Why |
|---|---|
| `agent.send`, `agent.send_review` `request_id` | The send's ID; becomes the accepted message's ID and keys the send journal |
| `agent.answer` `request_id` | The provider's pending request being answered |
| `queue.enqueue`, `queue.cancel` `request_id` | The queued prompt's ID |
| `attachment.put`, `attachment.import` `request_id` | Becomes the attachment ID |
| `draft.send.*`, `send_acknowledged`, send intents `request_id` | The send being prepared, completed or acknowledged |
| `context.capture` `request_id` | Names the captured node |
| Activity targets, orchestration pending requests `request_id`, `request_ids` | A question or approval's ID |

Not changed, and not on the daemon wire: the CLI's `--request-id` flags and the `request_id`
it echoes in its own JSON for Git, worktree, terminal and browser commands; the SDK Git
journal's record field; the desktop's review IPC arguments.

## 2b. Old-data conversions

Every profile database is created at the current schema (D19), so none of these serves data
a current build writes:

| Removed | Note |
|---|---|
| `legacy_secret_values`, `migrate_service_secrets` and its call at open | A stored secret without a reference is refused at save ("has no stored value") and at launch ("has no reference") |
| `plan_secrets` moving a stored plain-text value | Same |
| `legacy_reference`, `migrate_credential_settings` | A credential setting that is not a reference is still withheld from the plugin, now worded "is not a credential reference" |
| Proxy registry `route_id` backfill and the serde defaults on `service_identity`, `target_port`, `route_id` | A record without a route ID makes the registry corrupt, as any invalid record does |
| `Conversation.view_terminal`, the restart-time retirement of terminal attachments, the clear on resume, `clear_view_terminal` | Nothing sets `view_terminal`; contract regenerated |
| `resources.claim.resolve`: acknowledged and summary-only receipts | The current build commits the removal and its reply together |
| `resources.registry.accept`: summary-only receipts (`AcceptOutcome::Replayed(None)`) | Kept its acknowledged path: the accept records its reply in a second write, so a live crash can leave it acknowledged |

Deleted E2E: `secrets/services.spec.ts` "a secret stored in plain text before references
moves ..." and `secrets/plugins.spec.ts` "a plugin credential stored as text before
references moves ...", and one Rust unit test for the service migration.

## 3. Unknown provider

`ProviderNotFound` in `ade-core::error`: code `provider_not_found`, recovery `list_providers`,
message "Unknown provider: ID". Raised by `provider::descriptor` (so `conversation.create`
and `preset.save`), `provider.capabilities`, `provider.readiness`, registered-provider
lookups, `mcp.resolve` and MCP server provider selections. The SDK lists the code; the CLI
exits 31. E2E: `providers/unknown.spec.ts`.

## 4. Keybindings (F015)

- `ProfileSettings.keybindings`: every command in `AppCommand` (the ten desktop app commands)
  mapped to an Electron accelerator or null. Defaults live in `AppCommand::default_key`, equal
  to today's `APP_COMMAND_KEYS`. `settings.get`, `settings.set` and `settings_changed` carry
  them.
- `settings.set`: `keybindings` (command to key or null) merges with the other commands;
  `reset_keybindings` (`"all"` or a list) applies first; a command may not be in both.
- Refusals, each before anything changes: unknown command `unknown_setting`
  (`keybindings.ID`); not an accelerator `invalid_keybinding` (exit 32, names `command`); two
  commands on one key `keybinding_conflict` (exit 33, names `key` and `commands`). Conflicts
  count on macOS and elsewhere: `CmdOrCtrl+N` shares a key with `Cmd+N` and `Ctrl+N`;
  modifier order, case, `Return`/`Enter` and `Esc`/`Escape` do not matter.
- Accelerator rules (`ade-core::keybindings`, unit-tested): 1 to 64 printable ASCII
  characters, known modifiers without repeats, one final key (a printable character, F1 to
  F24, or a named Electron key).
- The store keeps only overrides, in the `keybindings` row of `profile_settings`.
- CLI: `ade settings set keybindings.COMMAND KEY|none` and
  `ade settings reset-keybindings [COMMAND ...]`.
- E2E: `profiles/keybindings.spec.ts`; `profiles/settings.spec.ts` updated for the new field.
- The desktop is not wired. One desktop test fixture
  (`profile-settings.test.ts`) casts its partial settings, forced by the now-required field.

## Found but not removed

- `Conversation.terminal_owner`, `Store::reserve_terminal`, `TerminalKind::Conversation`,
  `RemoveBlockerKind::ConversationInTerminal` and the "terminal" status: a handoff of a
  Conversation to a terminal with no caller since the initial source. Only store tests call
  `reserve_terminal`. Removing it changes contract enums.
- `Conversation.account_context` defaults to `legacy_ambient` when absent; the value itself
  is live.
- `ade_core::protocol::decode_snapshot` still reads the byte-array snapshot encoding beside
  base64.
- The CLI's `--request-id` flag names an operation ID for Git, worktree, terminal and
  browser commands.
- The coordinator's `acceptance/cli-window.spec.ts` needed no change: no CLI flag was renamed.
