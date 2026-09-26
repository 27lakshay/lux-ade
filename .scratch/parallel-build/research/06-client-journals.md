# Research 06: why the Electron send and Git journals exist

Ticket: [06-client-journals](../issues/06-client-journals.md). Code read at
`aae7cf3` (`codex/architecture-proposal`) in the `claude-parallel-build` worktree.
Nothing was run; every claim below comes from reading code and E2E specs.

## Answer

- **The send journal covers the window before the daemon holds anything.**
  Electron main writes the prompt, its request ID and the draft revision to
  `pending-sends-v1.json` *before* it calls `draft.save`, `draft.send.prepare` or
  `agent.send`. If Electron dies in that window, the daemon has no `send_intents`
  row and no message. Only the journal still knows the user pressed Send. For
  review feedback, the prompt text exists nowhere else.
- **After admission, the send journal mostly duplicates the daemon.** The
  daemon's `send_intents` row, keyed by `(conversation_id, window_id)`, plus the
  user message whose ID is the request ID, already make retry safe. The desktop's
  window ID is persisted (`window-owner-v1.json`), so `draft.send.get` can find
  the intent again. The journal adds four things the daemon lacks:
  1. a list of every pending prompt without knowing which conversations to ask
     about (the daemon has no "list intents for owner" query);
  2. that list while the daemon is unreachable (the "Pending prompts" panel);
  3. a `dispatchStarted` bit, which decides whether a failed prepare may discard
     the prompt;
  4. profile identity: records are keyed by profile ID, so a restore into a new
     profile needs the export/import bundle with `restoreHold`.
- **The Git journal keeps the operation ID the renderer generated.** The daemon's
  `jobs` table is a durable receipt keyed by request ID, but the daemon can only
  look it up *by ID*. There is no "operations for this workspace" query and no
  record that a person has seen an interrupted result. The Git journal therefore
  provides:
  - the ID after a renderer reload or Electron crash;
  - a rule of one unacknowledged operation per workspace;
  - an archive of interrupted operations the person has acknowledged.
- **The CLI moves the journal to its caller.** The caller must choose
  `--request-id`, keep it and retry with identical arguments. `conversation send`
  calls `agent.send` directly and does not use `send_intents`. `git
  feedback-send` derives a per-request owner (`cli-review-<sha256>`) so that
  `draft.send.prepare`, `agent.send_review` and `draft.send.complete` are each
  idempotent on retry. Git mutations are inspected with `git operation
  WORKSPACE_ID REQUEST_ID`. The CLI keeps no local state.
- **Relocation:** the daemon cannot cover the pre-admission window. That part has
  to stay on the client. Everything after admission can move into the daemon.
  That shrinks each journal to a small outbox, which could then live in
  `@ade/client`.
- **Feed catch-up** can move into `@ade/client` as a transport-free projection
  core. It cannot be persisted meaningfully yet: the daemon's revision is an
  in-memory counter that restarts at 0 with each new `boot_id`.

## 1. Send path, renderer to receipt

1. The renderer (`main.tsx` `send`) calls `adeHost.requestConversation('agent.send',
   { conversation_id, request_id: randomUUID(), text })`. The preload forwards it
   to `ade:conversation-request`.
2. Electron main (`index.ts` ~1306–1395) loads the `DraftEntry`. If
   `entry.send` already exists, it re-dispatches that intent with the original
   ID; the renderer's new ID is ignored. Otherwise it builds a `SendIntent`,
   calls `journal().upsert(..., dispatchStarted: false)` and then `flushDraft`.
   The E2E pause hook `ADE_E2E_SEND_JOURNAL_PAUSE` sits between these two calls.
3. `dispatchSend` (~427–570) then:
   - checks `activeProfile()` (same socket, same client generation, same review
     selection epoch);
   - re-reads the journal and re-verifies the daemon draft (`draft.get`, then
     `draft.save` if the saved revision is older);
   - calls `draft.send.prepare`, and on error `draft.send.get` to learn whether
     the intent was admitted;
   - calls `journal().markDispatched` and then `agent.send` or
     `agent.send_review`;
   - calls `acceptedSend`, which calls `draft.send.complete` and removes the
     journal record.

   An uncertain result at any step returns `send_pending` and keeps the ID.
   A daemon-confirmed rejection calls `draft.send.abort` and removes the record.
4. The daemon side:
   - `prepare_send_intent` inserts the `send_intents` row. It checks that the
     saved draft matches, and a unique index allows one pending intent per
     `(conversation, window)`.
   - `Sessions::send` calls `guard_send_intent`; `begin_content_turn` then
     deduplicates by message ID, which is the request ID.
   - `complete_send_intent` clears the draft and marks the row `completed` in
     one transaction. A repeated call returns the same cleared draft.
   - `abort_send_intent` accepts only a `rejected` intent.
   - Backup restore sets `restore_hold=1` on pending rows (`bin/control/backup.rs:293`).
     While the hold is set, `send`, `complete` and `abort` all refuse.
5. Relaunch: `loadDraft` reads `draft.get`, `draft.send.get` and the journal
   together. It fails closed if they disagree. It back-fills a missing journal
   record from the daemon intent (`dispatchStarted: true`), and it adds
   `restoreHold` when the daemon reports `restored_from_backup`.
6. Window close and app quit (`index.ts` ~1500, ~1606) reconcile each pending
   send. They refuse to close while a pending send is not journaled
   (`unsafePending`).

## 2. Git mutation path, renderer to receipt

1. The renderer (`review.tsx` `startGit`) generates `request_id =
   crypto.randomUUID()`. It sets React state and calls
   `adeHost.requestReview(op, pending)`, which maps to `ade:review-request`.
2. Electron main (~1066–1110) validates the fields and builds a `GitIntent`. It
   calls `gitRecovery().prepare(intent)`, which fsyncs `git-intents-v1.json` and
   rejects a second active operation in the same `(profile, workspace)`. Main then
   calls `requestDaemon(op)` and checks the receipt shape.
3. The daemon (`review.rs` ~1332–1406) looks up `jobs` by ID and returns the
   existing receipt when found. Otherwise it takes `review_guard`, inserts a
   `running` row, returns it, and runs the mutation on a thread that writes
   `succeeded` or `failed`. At daemon start, `running` rows become `interrupted`
   (`review.rs:1003`) and are never re-run.
4. Back in the renderer:
   - On mount it calls `readGitJournal`, then polls `review.operation` every
     750 ms.
   - `succeeded` or `failed` leads to `acknowledgeGitJournal(..., 'settle')`,
     which removes the active record.
   - `interrupted` shows a warning; the person acknowledges it, the record
     moves to `archived`, and it is listed afterwards.
   - "Unknown review operation" means the daemon never admitted the request.
     The UI then offers a retry with the original ID and parameters.

## 3. Crash windows: which layer covers each one today

"Daemon" means `send_intents`, message-ID deduplication or the `jobs` receipt.
"Journal" means the Electron file. "Neither" means nothing today would recover it.

### Send

| Crash window | Covered today by | E2E evidence |
|---|---|---|
| Before daemon admission: journaled, crash before `draft.save` | Journal only | `desktop-send-recovery` "a crash before draft.save reaches the daemon retries the journaled request once" |
| Before daemon admission: crash before `draft.send.prepare` | Journal only | same loop, `draft.send.prepare` |
| Before daemon admission: review feedback note | Journal only; the note exists nowhere else | `desktop-review-atomic-send` "a crashed Electron process restores the anchored note and original send ID"; "a changed diff after local send journaling cannot admit stale review feedback" |
| Prepared, crash before `agent.send` reaches the daemon | Both: daemon intent `pending`; journal `dispatchStarted: true` | `desktop-send-recovery` loop, `agent.send` |
| Lost `draft.send.prepare` reply | Daemon (idempotent prepare) plus in-memory `DraftEntry` | `desktop-send-recovery` "a delayed prepare commit after a lost reply keeps its ID in the live window" |
| Lost `agent.send` reply, then renderer reload or app close | Daemon deduplication plus journal (keeps the ID across close) | `desktop-send-recovery` "a dropped send reply keeps one prompt across renderer reload, hidden app close and retry" |
| Lost reply, then Electron SIGKILL | Daemon deduplication plus journal | `desktop-send-recovery` "a crashed Electron process recovers its send ID and does not dispatch a second provider turn" |
| Lost `draft.send.complete` reply | Daemon (idempotent complete) | `desktop-send-recovery` "a lost draft completion reply settles on retry without sending again" |
| Daemon rejects before admission | Daemon (`rejected`, then `abort`); journal record removed | `desktop-send-recovery` "a daemon-rejected prompt does not trap the draft or window"; `daemon-send-intent` "a confirmed pre-admission rejection can be aborted…" |
| Daemon restart with a pending intent | Daemon only | `daemon-send-intent` "a durable send intent survives lost acknowledgement and daemon restart…" |
| Relaunch while the daemon is unreachable | Journal only ("Pending prompts" panel) | `desktop-send-recovery` "Quit preserves an accepted prompt without a recurring native alert…" (asserts the panel, line 551) |
| Quit or close with an unreconciled prompt | Journal (`unsafePending` gate) | the Quit test above; "Quit reconciles an accepted prompt from an inactive managed profile" |
| Profile transfer (backup restored into a new profile) | Journal bundle; import verifies the daemon's restored intent | `send-journal-transfer` "pending-send transfer validates restored intent and holds replay across profile identities" |
| Restore hold | Daemon (`restore_hold=1`, refuses send, complete and abort); the journal mirrors it as `restoreHold` | `restored-send-hold` (daemon only); `send-journal-transfer` (journal auto-hold and imported hold) |

### Git

| Crash window | Covered today by | E2E evidence |
|---|---|---|
| Before daemon admission: journaled, crash before the request reaches the daemon | Journal only; the UI then gets "Unknown review operation" and offers a retry | **None** |
| Lost admission reply | Journal, re-read in the renderer's `catch`; the daemon receipt lookup is idempotent | Partial: `desktop-review-mutations` "a delayed Git admission reply stays bound to its original workspace" (delay only, not loss) |
| Relaunch while the operation is running | Journal (ID) plus daemon (`jobs` receipt) | `desktop-review-mutations` "Electron reopens with the original Git operation ID after a process crash"; `desktop-discard` "Electron retains the discard preview intent after a process crash" |
| Daemon dies during the mutation | Daemon marks the job `interrupted` and never re-runs it | `git-discard` (daemon/RPC level, line ~360); `review-mutations` accepts `interrupted` |
| Person acknowledges an interrupted result | Journal only (`archived`) | **None in desktop** |
| Profile transfer | **Neither.** The Git journal has no export or import, and records keyed by the old profile ID are orphaned | None |
| Restore hold | Not applicable. There is no Git hold; the restore fences the worktree lifecycle instead | `profile-backend-restore` (fence only) |

## 4. What the CLI does for the same failures

- **Send.** `conversation send ID TEXT [--request-id ID]` makes one `agent.send`
  call. A lost reply returns `unavailable` (exit code 3). A retry with the same ID
  and text returns `ack`, because the daemon deduplicates by message ID. Reusing
  the ID with different text or another conversation is refused. Evidence:
  `cli-send-retry` "CLI caller-owned send ID survives lost reply and daemon
  handoff without retargeting" (one `turn/start`). Without `--request-id`, the
  generated ID is lost with the reply. The usage text says so.
- **Review feedback.** `git feedback-send` runs `draft.get`, `draft.save` at
  revision 1, `draft.send.prepare`, `agent.send_review` and
  `draft.send.complete`. The owner is `cli-review-<hash(conversation, id)>`, so
  every step is idempotent when retried with the same ID. A daemon-rejected
  intent needs `draft.send.abort`, which the CLI reaches only through the generic
  `request OP`.
- **Git.** `git stage|unstage|commit|discard … --request-id ID` requires a
  caller ID. `git operation` reads the receipt. Neither command checks for
  another unacknowledged operation or records acknowledgement.
- **Not covered.** The CLI has nothing for the pre-admission window, a pending
  list, the quit gate, profile transfer or acknowledgement. The calling script
  or agent is the journal.

## 5. Where the guarantees could live

| Option | What it requires | What it buys | What breaks or costs |
|---|---|---|---|
| **A. Keep in Electron main** (status quo) | Nothing | No work; all current E2E stays green | About 400 lines of send state machine stay in `apps/desktop/src/main/index.ts`, the hottest merge-conflict file. The CLI and any future client re-derive the rules. Conflicts with the SDK owning synchronization. |
| **B. Move the journals and state machine into `@ade/client`** | Extract `SendJournal`, `GitJournal` and `dispatchSend` into the SDK, which is already Node-only (`node:net`), so `node:fs` fits. Inject what Electron owns today: an `isCurrent()` predicate (socket, generation, review epoch), a stable owner ID (today `windowId`), a profile-identity function and a state directory. | One implementation for desktop and CLI. Shrinks `index.ts`. | The CLI becomes stateful. Two CLI processes, or a CLI and the desktop, would share one file. The journals serialize writes only within a process (a promise tail), and last rename wins. This needs cross-process locking or one file per owner. The desktop also has no single-instance lock. Specs read `pending-sends-v1.json` fields directly, so path and format must stay. The quit gate, the "Pending prompts" panel and the transfer IPC stay in Electron. |
| **C. Move everything after admission into the daemon; keep a minimal outbox on the client** | New daemon operations: list pending send intents for an owner; list unacknowledged Git operations for a workspace; acknowledge an operation (a schema column in `jobs`). Optionally enforce one unacknowledged Git operation per workspace in the daemon. The client keeps only pre-admission records and deletes each one once `prepare` (or Git admission) returns. | The daemon becomes the one authority, matching section 4 (durable intent before dispatch; retry returns the known result). The profile transfer bundle becomes unnecessary, because backup already carries `send_intents` and `restore_hold`. `dispatchStarted` can be derived: no daemon intent means never dispatched. The CLI gains `send list` and `git operations` without local state. | Rust work in `sessions.rs`, `store.rs` and `review.rs` (all hotspot files), plus a migration. `send-journal-transfer` and the journal-field assertions in `desktop-send-recovery` must be rewritten to the new behavior first; AGENTS.md requires migrating coverage before retiring it. A pending list while the daemon is unreachable still needs the local outbox, and it shows only pre-admission prompts. |
| **D. Daemon cannot own pre-admission** | — | — | By definition the request has not reached the daemon. Some client-side durable record is unavoidable if "the user pressed Send" must survive a crash. |

**Pick: C, with the small outbox from B.** The daemon owns everything after
admission. `@ade/client` owns only a pre-admission outbox with a per-owner file.
Electron keeps the UI gates. This removes the most code from the hotspot files
over time. It also removes the transfer bundle, which exists only because the
journal is keyed by profile. The cost is protocol work in three hotspot Rust
files. This is a real trade-off for the user if it is to happen before v1. None
of it blocks parallel work.

## 6. Feed catch-up and projection

### What `ConversationView` does (`main.tsx` ~600–670)

- The effect runs per `conversation.id`, client `bootId` and a `refresh`
  counter. It keeps `current` (a snapshot with `boot_id` and `revision`), a
  `loading` flag, `reloadRequested`, and `buffered` frames.
- `apply(frame)` handles each frame:
  - No snapshot yet: it buffers the frame and starts `load()`.
  - Same boot and `revision <= current.revision`: it drops the frame as a
    duplicate.
  - Different boot, or `revision !== current.revision + 1`: it treats this as a
    gap. It drops the snapshot and the buffer and reloads; if a load is already
    in flight, it queues one.
  - `conversation_reload` for this conversation: it drops the snapshot and
    reloads.
  - Any other frame type, or a `conversation_changed` for another conversation:
    it advances only `current.revision`. The revision is global, so every frame
    must be counted.
  - `conversation_changed` for this conversation: it merges messages by `id`,
    sorts by `sequence`, keeps the last 200, replaces `requests` and sets the
    revision.
- `load()` calls `conversation.get` (via IPC to main, then the daemon). It sets
  the snapshot, replays buffered frames after the snapshot's revision, and stops
  if a replayed frame forces another reload.
- The frames reach the renderer through `AdeClient.subscribeFeed` in main,
  `broadcast('ade:feed-frame')` and `onFeedFrame`. Main forwards only frames
  from the current client generation.

### How the daemon produces the feed

- `Sessions::publish` (`sessions.rs:702`) increments `Data.revision: u64` and
  stamps `revision` and `boot_id` on every event. It then calls `try_send` to
  each subscriber's bounded channel (capacity 128).
- A full or closed channel removes that subscriber. The server loop
  (`bin/daemon/server.rs:821`) then ends and shuts the socket. `AdeClient`
  reconnects and receives a new `catalog` frame at a later revision. The
  renderer sees that jump and takes a new snapshot.
- The revision is **in memory, per boot**. It starts at 0 in `Sessions::new`,
  and `boot_id = new_id("boot")`. It is not stored in SQLite. A daemon restart
  makes every cursor worthless.
- `subscribe` sends an initial `catalog` frame at the current revision. The
  frame is taken under the lock and retried up to 3 times if the revision moves
  during filesystem probes.
- `conversation.get` returns `boot_id` and `revision`, read under the same lock
  as the messages, so the snapshot and its watermark match.
- `AdeClient.applyFrame` already rejects a non-contiguous revision on its own
  connection, which forces a reconnect. The renderer's gap check is a second
  line of defense for reconnects, generation switches and IPC.
- Evidence: `desktop-incremental-feed` "conversation feed applies deltas and
  resnapshots after a missing revision". It drops one frame at the proxy,
  asserts a resubscribe, at most 6 snapshot reads, and no polling at rest.

### What moving it into `@ade/client` requires

The architecture (section 6) says the SDK is the single implementation of
synchronization. It "applies and persists a projection and its cursor", and it
distinguishes connected from current.

1. **Split the SDK into a transport-free core and a Node transport.** The
   renderer cannot import `node:net`; today it imports only types from
   `@ade/client`. Add a subpath such as `@ade/client/sync` with no Node imports.
   It would export a `ConversationProjection` state machine (the logic above)
   that takes an injected `fetchSnapshot(id)` and a frame source. The desktop
   injects IPC; a future Node client injects `requestDaemon` and `AdeClient`.
   The alternative is to run the projection in Electron main and push projected
   state over IPC. That keeps the SDK Node-only, but it grows `index.ts` and
   needs per-renderer subscription reference counts.
2. **Expose status**: `loading`, `current` (snapshot applied and buffer drained)
   and `stale` (a gap is being repaired). This meets the "connected versus
   current" rule. React then only renders the state.
3. **Persistence waits for the daemon.** Scoping a cursor to host, profile,
   history epoch and subscription needs a durable feed position. Today a restart
   always means a full snapshot. The map puts the durable change feed out of
   scope, so the SDK would persist nothing now. Its API should still take a
   cursor scope, so it does not change later.
4. **Keep the current limits and fix a known mismatch.** The snapshot's
   `conversation.get` defaults to 50 messages, but merged deltas are capped at
   200. The SDK should own history paging, per section 6 ("page and virtualize
   long history").
5. **E2E must stay green.** `desktop-incremental-feed` asserts no transcript
   polling and a bounded number of snapshot reads. Per AGENTS.md, no unit tests
   may be added for the extracted state machine; E2E remains the proof.

## Uncertain or skipped

- No spec was run. The window-to-spec mapping comes from test titles, pause
  hooks and the key assertions I read, not from executing the specs.
- Git has no E2E for three windows: pre-admission crash, lost reply followed by
  the "was not found → retry" path, and acknowledgement of an interrupted
  operation in the desktop.
- The Git journal is not part of profile transfer. After a restore into a new
  profile ID, a pending Git record is invisible. I did not confirm whether any
  flow clears or migrates it.
- I found no `requestSingleInstanceLock` in `apps/desktop/src`. Two desktop
  instances sharing `userData` could overwrite each other's journal files. I
  did not check whether packaging or the launcher prevents this.
- I did not trace `reviewSelection.epoch` semantics or the review `sessionStorage`
  path in `review.tsx` in full.
- "`dispatchStarted` can be derived from the daemon" (option C) assumes the
  desktop always prepares before sending. That holds in `dispatchSend` today, but
  `agent.send` also accepts a request with no intent (the CLI path). A restored
  older backup could also break the assumption.
