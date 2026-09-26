# Research: seams in the five hot files

Ticket: [05-hot-file-seams](../issues/05-hot-file-seams.md) · Researched 2026-09-27 against
`codex/architecture-proposal` at `aae7cf3` · Research only: nothing was split, branched or committed.

## Recommendation

Split the three TypeScript files first, then `sessions.rs`. Leave `store.rs` for last.

1. **Desktop main (`apps/desktop/src/main/index.ts`).** Move each `ipcMain.handle` group
   and its helpers into a domain module. Add one small `profile-connection.ts` that
   exposes the current endpoint, client and generation. This is the largest win.
2. **Renderer (`apps/desktop/src/renderer/src/main.tsx`).** Move `ServicePane`,
   `TerminalPane`, `ConversationView`, `RestoreBindingsPanel` and an extracted
   `AccountsPanel` into their own files, beside the existing `files.tsx`,
   `review.tsx`, `scripts.tsx` and `browser.tsx`.
3. **CLI (`apps/cli/src/index.ts`).** Move each `area` block of `run()` into
   `commands/<area>.ts`. Each module exports its own usage lines. Without that
   usage change the split removes no conflicts, because every CLI feature edits
   the single `usage` string.
4. **`sessions.rs`.** Turn it into `sessions/mod.rs` with child modules that add
   `impl Sessions` blocks. Rust lets child modules read the parent's private fields,
   so this is a pure move.
5. **Desktop host bridge (interface change).** Give every domain its own namespace
   on `window.adeHost`, as `browser` and `terminal` already have. Add a quit-guard
   registry so features stop editing the `before-quit` handler.
6. **`store.rs`.** Use the same child-module move as step 4. Keep the migration
   ladder in one place, and have the coordinator assign schema version numbers.

In the history since `e42e5e7`, steps 1–4 separate about two thirds of the
cross-feature co-edits in these files. Steps 5–6 bring that to about four fifths.
The remainder is real coupling, mainly the prompt send path, which review feedback
and conversations both extend. No file split removes it.

The [architecture proposal](../../../docs/proposed-architecture.md) warns that "a
folder per feature … does not establish modularity". These splits only reduce edit
contention. They do not settle the deep-module interfaces. Treat them as mechanical
preparation, not as architecture.

## Evidence: how the files were co-edited

The method used `git log e42e5e7..aae7cf3`: 164 commits, 79 of which touch at least one
of the five files. A script mapped every diff hunk to its enclosing region at that commit:
the function, the `ipcMain` channel, the `command()` match arm or the CLI `area` block.
Each commit was tagged with a feature area from its subject line. The metric counts
**pairs of commits from different feature areas that edited the same unit**. Before a
split, the unit is the file. After a split, it is the proposed module. The metric is a
proxy for conflict risk if the work had run in parallel. These commits ran serially,
so they never actually conflicted.

| File | Commits touching it | Cross-area pairs now | After pure moves | After interface changes too |
|---|---:|---:|---:|---:|
| `apps/desktop/src/main/index.ts` | 43 | 772 | 224 | 145 |
| `apps/desktop/src/renderer/src/main.tsx` | 36 | 537 | 208 | 113 |
| `crates/ade-daemon/src/sessions.rs` | 27 | 272 | 90 | 90 |
| `apps/cli/src/index.ts` | 25 | 255 | 255 (usage string is shared) | 30 |
| `crates/ade-daemon/src/store.rs` | 17 | 114 | 52 | 52 |
| **Total** | | **1,950** | **829** | **430** |

Co-edits between files: `index.ts`+`main.tsx` together in 32 commits;
`sessions.rs`+`store.rs` in 16; CLI+`index.ts` in 12. Two adjacent files are almost as hot
and are not in this ticket: `apps/desktop/src/preload/index.ts` (20 commits) and
`apps/desktop/src/renderer/src/style.css` (19). The daemon's
`bin/daemon/server.rs` `handle_connection` is a second op-dispatch point (7 commits).

Hottest regions (commits, feature areas that edited them):

| File | Region | Commits | Areas |
|---|---|---:|---|
| main `index.ts` | `openMainWindow` + `before-quit` lifecycle | 18 + 4 | 01, 03, 06, 07, 08 |
| main `index.ts` | `ade:conversation-request` handler + `conversationOps` | 16 + 5 | 01, 02, 03, 06 |
| main `index.ts` | `loadDraft` / `dispatchSend` / `SendIntent` / journal | 7 each | 03, 06 |
| renderer | `declare global` `Window.adeHost` typing | 18 | 01, 03, 05, 06, 07, 08 |
| renderer | `ConnectedContent` (sidebar, accounts, work area) | 16 | 01, 02, 03, 05, 06, 07 |
| renderer | `ConversationView` | 10 | 02, 03, 05 |
| preload | `exposeInMainWorld` object | 18 | 01, 03, 05, 06, 07, 08 |
| CLI | `usage` string | 25 of 25 | all seven |
| `sessions.rs` | structs incl. `Data` | 8 | 02, 05, 06, 07 |
| `sessions.rs` | `command()` preamble (prefix admission and delegation) | 8 | 05, 06, 07 |
| `sessions.rs` | `send` | 6 | 02, 03, 05, 06 |
| `store.rs` | `Store::open` migration ladder | 8 | 02, 03, 05, 06, 07 |
| `store.rs` | send-intent functions | 3–4 each | 03, 05, 06 |

Domain regions that already stay in one area (`ServicePane` 8 commits, `ade:service-request`
6, `inspect_service` 5, `ade:review-request` 5) are the ones a move isolates cleanly.

## `apps/desktop/src/main/index.ts` (1,669 lines)

Precedent: `browser.ts` already registers its own handlers through `registerBrowserIpc`,
and `send-journal.ts` and `git-journal.ts` are already separate.

| Proposed module | Current lines | Domain | Crossing shared state | Kind |
|---|---|---|---|---|
| `profile-connection.ts` (profiles, client attach, launcher) | 15–30, 578–719 | 01 | Writes `socket`, `client`, `clientGeneration`, `switching`, `profileState`; everyone reads them | Interface: export read accessors, because importers cannot reassign module `let`s |
| `conversations/send-pipeline.ts` (drafts, send intents, journal, reconcile) | 31–106, 248–577 | 03 | `drafts`, `DraftEntry`, `SendIntent`, `sendJournal`, `windowIds`, `singleWindowId`; review feedback calls `dispatchSend` | Move, plus connection accessors |
| `conversations/ipc.ts` (`ade:conversation-request`, pending sends, journal transfer) | 760–797, 1199–1413 | 03 + 02 | `conversationOps` allowlist, the send pipeline, `validId` | Move |
| `accounts-ipc` (account ops, now inside the conversation handler) | inside 1204–1413 | 02 | Same allowlist and channel as conversations | Interface: own channel or own op set |
| `review.ts` (review context, feedback prompts, `ade:review-request`, git journal) | 107–247, 1043–1161 | 06 | `selectedWorkspaces`, `selectionRequests`, `gitJournal`, the send pipeline | Move |
| `files.ts` (`ade:file-request`) | 1162–1198 | 06 | Review context helpers | Move |
| `workspaces.ts` (open, choose, restore bindings, workspace select) | 798–897 | 05 | `selectedWorkspaces`, `restoringBinding`, `selectProfile` | Move |
| `services.ts` (`ade:script-request`, `ade:service-request`) | 898–1042 | 07 | `serviceOps`, `scriptOps`, connection accessors | Move |
| `terminals.ts` (`ade:terminal-*`) | 1414–1458 | 07 | `terminals` map, closed on quit and on profile switch | Move; export `closeAll()` |
| `browser` IPC remnants (adopt, backup) | 720–759 | 08 | `browserOwner` | Move into existing `browser.ts` |
| `index.ts` (window, lifecycle, `before-quit`) | 1459–1669 | 01 | Quit flags; drafts flush and browser flush | Interface: a quit-guard registry, so features register a flush |

## `apps/desktop/src/renderer/src/main.tsx` (1,284 lines)

Precedent: `files.tsx`, `review.tsx`, `scripts.tsx` and `browser.tsx` are already separate
panes that take `workspace` as a prop.

| Proposed module | Current lines | Domain | Crossing shared state | Kind |
|---|---|---|---|---|
| `host.d.ts` (`Window.adeHost` typing) | 79–116 | shared | The preload object and the main IPC channels | Move now; later give each domain its own interface merged into `adeHost.<domain>` |
| `types.ts` (Frame, Message, Service, Account, Restore types) | 11–78 | shared | `@ade/client` types | Move |
| `services.tsx` (`ServicePane` + proxy types) | 44–78, 117–470 | 07 | `workspace` prop; `openPreview` calls `adeHost.browser` | Move |
| `terminal.tsx` (`TerminalPane`) | 471–490 | 07 | `workspace` prop | Move |
| `conversation.tsx` (`ConversationView`, `RequestForm`, summaries) | 491–791 | 03 | `conversation`, `bootId`, `accountLabel`, `fenced` props | Move |
| `restore.tsx` (`RestoreBindingsPanel`) | 792–870 | 05 | `onWorkspaceBindings` callback, `profileKey` | Move |
| `accounts.tsx` (`AccountsPanel`) | ~150 lines inside `ConnectedContent` (state 880–887, handlers 939–1003, JSX 1097–1147) | 02 | `accounts` list, also read by the new-conversation selector and `accountLabel` | Interface: lift `accounts` into a hook or pass it up |
| `ConnectedContent` (sidebar and work-area composition) | 871–1160 | shared | Selection: `workspace`, `conversation`, `workspaceFenced`, `acknowledgedSelection`, `profileKey` | Stays; each new pane still adds one line to the work area |
| `App` (profiles, pending sends) | 1161–1284 | 01 | `ProfileState`, pending sends | Stays |

`style.css` should follow the panes, one stylesheet per pane. That is a pure move.
I did not analyze its co-edit regions.

## `apps/cli/src/index.ts` (1,181 lines)

| Proposed module | Current lines | Domain | Crossing shared state | Kind |
|---|---|---|---|---|
| `commands/workspaces.ts` (workspace, repository, worktree) | 751–808, 429–444 | 05 | `catalog()`, arg helpers | Move + usage fragment |
| `commands/conversations.ts` (list, inspect, export, create, send, cancel, resume, answer) | 466–547, 809–879 | 03 | `catalog()` | Move + usage fragment |
| `commands/accounts.ts` | 880–898 | 02 | `generation()` | Move + usage fragment |
| `commands/terminals.ts` (list, create, operation, stop, inspect, send, resize, attach) | 548–747, 899–947 | 07 | `main()` routes `terminal attach` specially | Move + usage fragment |
| `commands/services.ts` (service, script, listener) | 963–1069, 1140–1143 | 07 | `port`, `tailBytes`, `sha256`, `jsonObject` | Move + usage fragment |
| `commands/git.ts` (status, diff, feedback, mutations) | 320–428, 1070–1139 | 06 | `namedOptions`, `sendReviewFeedback` | Move + usage fragment |
| `commands/browser.ts` | 948–962 | 08 | none | Move + usage fragment |
| `index.ts` (parse, profiles, errors, arg helpers, dispatch) | 19–319, 1144–1181 | 01, 09 | `CliError`, `requestDaemon`, help ordering | Interface: assemble usage from the modules in a fixed order |

The usage text is the only conflict site that every one of the 25 CLI commits
edited. Keep the assembled help byte-identical, and pin the section order in
`index.ts`.

## `crates/ade-daemon/src/sessions.rs` (3,606 lines)

Precedent: `services.rs` already adds an `impl Store` block from outside `store.rs`.
Child modules of `sessions` can read private `Sessions` and `Data` fields, so the method
moves below need no visibility changes.

| Proposed module | Current lines | Domain | Crossing shared state | Kind |
|---|---|---|---|---|
| `sessions/services.rs` (`HealthCheck`, health sampling, `inspect_service`, listeners, peers, start/stop, `service.*` and `listener.list` arms) | 30–176, 1011–1131, 1830–2603 | 07 | `Data.health_samples`, `health_attempts`, `active_health_samples`, `stopping_services`, `Data.store`, `runtime`, drop guards | Pure move; nesting those four fields in one `ServiceRuntime` sub-struct is optional and removes most `Data` edits |
| `sessions/agents.rs` (`send`, `resume`, `attach_agent`, `events`, `cancel`, `answer`, `dispatch_queued`, `SendAdmission`, `Agent`) | 35–48, 177–183, 387–433, 2604–3566 | 03 (+02) | `Data.agents`, `publish`/`changed`, `queue_wake`, `runtime`, the store's send-intent API | Pure move |
| `sessions/conversations.rs` (conversation, draft, queue, attachment, agent and window arms) | 946–1010, 1373–1769 | 03 | Same as `agents.rs`; review feedback enters through `agent.send_review` | Pure move (arm bodies become methods) |
| `sessions/accounts.rs` (`provider.list`, `account.*` arms, `ensure_account_current`) | 1132–1241, 2861–2879 | 02 | `Data.store`, `Data.agents` for the generation check | Pure move |
| `sessions/workspaces.rs` (`selected_binding`, rebind arms, `open_workspace`, catalog, restore fence) | 246–310, 637–733, 1242–1345 | 05 | `Data.store`, `worktrees`, `draining`, `catalog_changed` | Pure move |
| `sessions/terminals.rs` (`terminal.*` arms, `clear_view_terminal`, leases) | 659–670, 1346–1372, 1770–1829 | 07 | `Data.terminal_leases`, shared with script runs | Pure move |
| `sessions/mod.rs` (`Sessions`, `Data`, `open`, `restore`, subscribe, `command()` preamble and thin match) | 1–30, 203–245, 311–386, 434–636, 755–945 | core | Workspace-bound admission by op prefix; delegation to review, files, scripts, worktrees | Stays; the preamble is still an 8-commit hotspot. Moving admission into each domain module is an interface change. |

## `crates/ade-daemon/src/store.rs` (3,765 lines)

The same child-module move applies. Shared helpers (`one`, `all`, `encode`, `decode`,
`check_id`, `check_text`, `transaction`, `BUSY`, `TEXT_LIMIT`) stay in `store/mod.rs`
and become visible to child modules unchanged.

| Proposed module | Current lines | Domain | Crossing shared state | Kind |
|---|---|---|---|---|
| `store/migrations.rs` (`Store::open` version ladder) | 661–920 | shared | Every table; the `0..=16` bound; `schema_migrations` | Move; version numbers still collide, so the coordinator assigns them |
| `store/accounts.rs` | 921–1130 | 02 | `accounts` table, `data_directory` | Pure move |
| `store/send_intents.rs` (send intents and drafts) | 315–364, 1131–1409 | 03 | `drafts`, `send_intents`, attachments validation; review feedback extends it | Pure move |
| `store/bindings.rs` (path bindings, rebind, restore fence, catalog claims) | 19–229, 1416–1745, 1759–1790 | 05 | `ensure_workspace_bound`, called from almost every other seam | Pure move |
| `store/terminals.rs` (terminal reservation and creation, script runs) | 365–382, 1791–1942 | 07 | `terminal_creations`, conversation `terminal_id` | Pure move |
| `store/attachments.rs` | 230–314, 389–435, 504–660 | 03 | `drafts` and `queued_prompts` columns | Pure move |
| `store/conversations.rs` (create, messages, queue, turns, commit, recovery, feedback search) | 457–502, 2047–2603 | 03 | `model::*` types in `ade-core` | Pure move |
| `store/windows.rs` | 2604–2714 | 01 | `windows`, `forget_terminal_views` | Pure move |
| `store/tests.rs` (legacy tests) | 2726–3765 | – | none | Pure move; low value (3 commits) |

## Recommended order

Ranked by the cross-area pairs each step removes from this history. Each step is
one commit made by the coordinator while no worker holds these files.

| Order | Step | Kind | Pairs removed | Running total left of 1,950 |
|---:|---|---|---:|---:|
| 1 | Desktop main: per-domain IPC modules + `profile-connection.ts` | Move + accessor | 548 | 1,402 |
| 2 | Renderer: extract panes, types and host typing; lift `accounts` | Mostly move | 329 | 1,073 |
| 3 | CLI: `commands/<area>.ts` with usage fragments | Move + usage assembly | 225 | 848 |
| 4 | `sessions.rs` → `sessions/` child modules | Pure move | 182 | 666 |
| 5 | Host bridge per-domain namespaces (main + preload + typing) and quit-guard registry | Interface | 174 | 492 |
| 6 | `store.rs` → `store/` child modules; coordinator assigns migration versions | Pure move + rule | 62 | 430 |

Steps 1–3 are TypeScript-only, and each takes one check run. Step 4 needs only
`cargo check` and the existing gates. Do steps 1 and 5 back to back if the
bridge namespace work is accepted. Step 5 renames IPC channels in three files
at once, so it is cheapest while those files are freshly split.

## What is uncertain

- **The metric is a proxy.** The history is serial work by one agent. The pair counts
  show where different features landed in the same unit. They do not count real merge
  conflicts, and they weight long-lived regions heavily.
- **Feature areas come from keyword rules on commit subjects.** About ten commits
  span two areas, for example "manage Claude accounts in desktop and CLI" and
  "fence restored profile execution". Each was counted in one area only.
- **Region attribution is heuristic.** TypeScript hunks map to the nearest top-level
  declaration. The `ConnectedContent` sub-split used line keywords. The Rust label
  "command preamble" lumps together the worktree, review, file and script
  delegation blocks.
- **The remaining 430 pairs are mostly real coupling.** Review feedback extends the
  conversation send path (`dispatchSend`, `SendIntent`, `send`, `guard_send_intent`).
  Migrations are serial by nature. `Data` and the `command()` preamble are shared
  daemon state. Only interface work reduces these, and that belongs to the command
  envelope and wire-typing tickets (11, 04), not to a file split.
- **Skipped.** `preload/index.ts`, `style.css`, `server.rs` and `ade-core/src/model.rs`
  (7 commits) were checked for commit counts only. Their regions were not mapped.
  I did not check whether E2E asserts the exact CLI help text.
