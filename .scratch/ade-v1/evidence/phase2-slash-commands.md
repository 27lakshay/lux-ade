# slash-commands

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-2
Worker: Phase 2 round E, slash-commands worker
Requirements: F037 (advanced, not accepted)

## Outcome

The daemon now lists the slash commands and skills one Conversation's provider
can be asked to run, and invokes a listed one in the provider's native form.
The listing merges command files, provider skill roots and ADE's skill catalog,
with provenance and argument hints. An invocation is an effect command: its
receipt stores the exact native text, then the text joins the Conversation's
prompt queue. Claude and Oh My Pi are invocable. Codex and OpenCode entries are
listed as unavailable with the missing native mechanism. F037 is not accepted:
there is no UI, no E2E, and no live provider run.

## Operation tiers

| Operation | Tier | Notes |
|---|---|---|
| `command.list` | query | Reads provider paths and the skill catalog. Writes nothing. Each entry has `invocable`, `invocation`, `mechanism` and `reason`. `native_catalog` says which live provider list ADE does not query yet. `skipped` names unread paths and scopes. |
| `command.invoke` | effect command | Receipt in the profile database. It records `{text, mechanism}` as dispatched before the queue write. It queues under the derived ID `<operation_id>:command` and settles `queued`. An unavailable or missing entry records no receipt. |

Native forms, as `sessions/commands/catalog.rs` records them:

| Provider | Command | Skill |
|---|---|---|
| Claude Agent SDK 0.3.281 | `/name args` as the prompt | `/name args` as the prompt |
| Oh My Pi (RPC `prompt`) | `/name args` | `/skill:name args`, while `skills.enableSkillCommands` is on (its default); the entry carries this caveat |
| Codex 0.157.0 app-server | unavailable: the app-server has no slash commands; custom prompts are TUI-only | unavailable: needs a `skill` turn input item, which ADE's adapter does not send |
| OpenCode v2 | unavailable: needs the session command path, which ADE's bridge does not call | unavailable: needs the prompt's `skills` field, which ADE's bridge does not send |

Decisions:

- **Claude loads a scope only when the Conversation enables its setting source.**
  User entries need `user` and project entries need `project`. Without them the
  entry is listed with that reason and cannot be invoked. The default Claude
  configuration enables none.
- **Ambiguous entries fail closed.** Two invocable entries with the same native
  text are both withheld, because ADE cannot tell which one the provider runs.
  For Claude, a command and a skill of one name are ambiguous.
- **Managed accounts skip the user scope.** A Conversation under an ADE-managed
  account has its own native home, which this listing does not read. The skip is
  reported in `skipped`.
- **Catalog bundles are matched by content hash.** A catalog bundle that matches
  a provider skill annotates it (`catalog_name`). A bundle found in no provider
  path is listed as `ade_catalog` and unavailable, because placement is not built.
- **Retries converge.** A retry after a lost reply re-offers the stored text
  under the same queue ID. The queue treats the same text as already done and
  refuses a different prompt under that ID. A settled receipt returns its stored
  reply. Any other receipt state settles `unknown` and never queues.
- **`queued` is not a provider acknowledgement.** The prompt queue delivers the
  text through the existing send path and its own delivery receipts.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/sessions/commands/catalog.rs`: provider roots and the skipped home, Claude setting sources, unavailability for Codex, OpenCode and unknown providers, Oh My Pi skill prefix and caveat, ambiguity, invalid entries, catalog matching, missing versus unavailable, native text, argument and name checks, frontmatter reading, native catalog reasons
  - `crates/ade-core/src/contract/commands.rs`: declared tiers, request and reply round trips, schema rejection of an unknown kind

Verified only statically: the `command.*` handlers, the filesystem scan of
command directories, the receipt and queue path, and the `ade command` CLI.
None of them ran against a live daemon or provider in this slice.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 5 | 10 | 0 |

## References

- Claude Agent SDK 0.3.281 `sdk.d.ts` (`providers/claude/node_modules`), studied: `SlashCommand` (name, description, argumentHint), `supportedCommands()`, init `slash_commands` and `skills`, `commands_changed`.
- Codex 0.157.0 app-server JSON Schema (generated locally with `codex app-server generate-json-schema`), studied: `UserInput` `skill` variant (`name`, `path`), `skills/list`; no slash command method.
- oh-my-pi @ ade-evaluation-2026-09-24 `docs/rpc.md` (`prompt`, `agentInvoked`, `get_available_commands`), `packages/coding-agent/src/extensibility/skills.ts` (`/skill:` parsing), `extensibility/settings.ts` (`skills.enableSkillCommands`, default true), `modes/rpc/rpc-mode.ts`, `discovery/builtin.ts` (command directories), studied.
- oh-my-pi @ ade-evaluation-2026-09-24 `packages/coding-agent/src/discovery/opencode.ts`, `discovery/claude.ts`, `discovery/codex.ts`, studied: command and prompt directories per provider.
- opencode-v2 @ ade-evaluation-2026-09-24 `packages/core/src/session/command.ts`, studied: commands run through `SessionCommand.execute`; prompts carry a `skills` field.
- No code was copied.

## Open

- E2E later: list and invoke a Claude project command with `project` enabled and
  observe the command run; invoke with the source disabled and see
  `unavailable`; delete the file and see the missing failure; retry an
  invocation with the same operation ID and see one queued prompt; invoke a
  Codex or OpenCode entry and see `unavailable` with nothing queued.
- UI later: a command menu fed by `command.list`, with provenance, argument
  hints and the unavailable reason.
- Not built: live provider command lists. These are Claude
  `Query.supportedCommands()` and `commands_changed`, Oh My Pi
  `get_available_commands`, Codex `skills/list` and OpenCode's command list.
  Without them, built-in, plugin and MCP commands are not listed and cannot be
  invoked through ADE.
- Not built: Codex skill invocation (a `skill` turn input item in the Codex
  adapter and the prompt queue), and OpenCode command and skill invocation
  (the session command path and the prompt `skills` field in the bridge).
- Not modelled: the account-specific native homes (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`), Claude command subdirectories (namespaced commands), the Claude
  skill frontmatter `argument-hint` and `user-invocable`, and whether Oh My Pi's
  `skills.enableSkillCommands` is actually on.
- Races left open: a command file can change between the listing and the queue
  dispatch. The provider reads the file at run time.
- No `command.*` feed frame. Clients re-query after changes.
- The CLI adds three lines to `apps/cli/src/index.ts`: an import, the usage
  fragment and the command area. `sessions.rs` adds `mod commands;` and one
  dispatch line.
