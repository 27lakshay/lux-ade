# Client task lifetimes

lux-ade's daemon owns application state. The runtime supervisor owns provider and terminal processes. Closing a client view must not send a process-stop command implicitly.

## Subscription ownership

`ClientState` owns a cancellation handle for its application event subscription. The subscription thread holds a weak reference to `ClientState`, upgrades it only while applying an event, and releases it before waiting for network input. Dropping the final client owner shuts down the subscription socket and wakes its reconnect wait. This cancels the subscription, not the daemon or its processes.

Connection establishment and hello use an absolute five-second deadline, including nonblocking Unix-socket connection and deadline-aware reads/writes. Ordinary RPCs have a five-second total deadline; review RPCs have sixty seconds. A slow stream of bytes cannot extend those deadlines. An in-progress hello is not interrupted immediately by owner destruction; it cannot retain `ClientState` and exits after the bounded handshake completes. Established idle subscriptions wake immediately on socket shutdown.

Client RPC and terminal startup reads use the shared `ade-platform::ipc::read_until`
helper. It waits for socket readiness against an absolute deadline, then reads from
the blocking socket's sole reader. It does not change `SO_RCVTIMEO`: on the tested
Mac, changing that option after peer closure returns `EINVAL` even when a complete
reply or final terminal output remains buffered. Hangup therefore proceeds to a
read so buffered bytes can drain. Established terminal streams have no read deadline;
their owner still cancels them through socket shutdown.

The recovery controller also uses weak client ownership between polls. It exits within one second of losing its owner while idle. An already admitted recovery action retains its owner until the action finishes; restarting a daemon cannot safely be treated as cancelled merely because its view closes.

Recovery control has one worker and one pending request slot. UI admission uses
nonblocking `try_send`; a full slot preserves the existing request and reports
that recovery is already waiting. A disconnected worker releases the busy state,
clears the unaccepted action notice, and tells the user to reopen lux-ade. The busy
flag suppresses duplicate actions, while the channel bound also covers a status
poll completing around admission. Neither path replaces or replays queued work.

## Command admission

Commands use fixed process-lifetime worker pools:

| Queue | Workers | Pending jobs | Pending serialized payload budget |
| --- | ---: | ---: | ---: |
| Ordinary commands | 4 | 64 | 32 MiB |
| Disposable pane reads | 2 | 64 | 32 MiB |
| Cancel, answer, disconnect | 1 | 16 | 32 MiB |
| Window and draft persistence | 1 | 128 | 32 MiB |

The control queue lets cancellation and approval answers proceed while ordinary requests, including reviews, are busy. A rejected enqueue returns an error and publishes a visible client error. It does not silently discard an operation. Active requests retain their existing network deadlines; queued requests are not new detached threads.

Admitted commands retain the shared client until they finish. Dropping a response receiver does not cancel a mutation: many callers intentionally submit saves and commands without waiting for a reply. Treating receiver closure as cancellation would lose data or leave the outcome of a submitted operation unknown.

One-shot response receivers in Review, Worktrees, Services, and terminal creation
normalize a closed channel into an explicit unknown-outcome error. Completion
releases pending/loading state while preserving the current projection. This
covers lost local completion delivery, distinct from a daemon-returned error.
It does not cancel or replay an admitted mutation. Existing weak view ownership
and Services generation checks still decide whether a completion can update a view.
A rendered Review regression drops the response sender and verifies that the pane
leaves its busy state with its previous repository projection intact.

The native menu/shortcut bridge retains at most 32 command indices, one overflow
flag, and one wake-up token per window. Accepted commands drain in FIFO order;
rejected input becomes an explicit Overflow event after that queue drains. The
bridge never blocks the native callback waiting for a consumer and never replays
rejected commands. Destroying the bridge unregisters the native callback before
freeing its context; receiver closure stops accepting input.

Input overflow has a separate disposable client flag and a dismissible shared
notice. Ordinary action/save completion cannot clear it. Dismissal clears only
that flag and leaves operation failures intact. The shell displays the notice even
when the selected tab is empty; retained standalone Conversation rendering also
supports it. Tests call the real FFI callback through its context and verify
accepted order plus explicit overflow, then exercise the rendered Dismiss control.

## Persistence ordering

Pending `window.save` operations coalesce by window ID. Pending `draft.save` operations coalesce by window and conversation IDs. A lower draft revision cannot replace a newer pending draft. Superseded callers receive an explicit superseded result, while the latest save retains its normal acknowledgement/error handling.

Coalescing never crosses a read, close, or flush boundary. One persistence worker preserves those boundaries. Saves already executing are never replaced. A flush synchronously appends a zero-byte fence at the call boundary, then acknowledges only after preceding saves have executed. Sixteen reserved fence slots allow flushing a full 128-job persistence queue. Exhausting those slots returns an explicit retry error without adding work or threads; the close gate keeps the window and drafts open. The fence returns `Result<(), String>`. Failed saves remain sticky until a newer successful save of the same window or draft identity clears them. Unrelated successful saves and older in-flight saves cannot hide a failure. `window.close` is an explicit separately acknowledged operation, so a failed close does not prevent reaching that operation on retry. At most 128 distinct failed identities are retained; overflow refuses a successful fence rather than silently losing failure state.

Save failures have a separate client projection from action errors. Both rejected
queue admission and completed save requests update that projection from the same
failed-save tracker used by the close fence. A successful save clears only its
matching identity; another window or draft can remain unsaved. Ordinary action
success cannot clear a save notice, and recovering a save cannot clear a separate
action error. Updating the tracker and its visible projection uses one lock order,
so concurrent admission failures cannot publish an older projection afterward.
The notice is shown in Conversation views; the window-close dialog remains the
explicit retry surface for saving retained data before close.

## Draft load recovery

Draft initialization starts before the Workspace constructor returns. Draft reads and
explicit conflict-resolution responses capture their actual window handle instead of relying
on GPUI's render-derived entity-to-window mapping. This prevents a completion arriving before
rendering in a new window from being silently discarded when its previous window has closed.
The asynchronous task holds a weak editor reference; closing the window or dropping the editor
discards completion, and conversation/generation guards reject superseded results.

Draft loading has explicit Loading, Ready, and Failed states. Transport errors, a closed response channel, and malformed responses leave Loading and show **Retry loading draft**. The client keeps the editor guarded until a successful retry or retained draft restores its text; it never interprets a failed read as an empty saved draft. Conversation and generation checks reject late responses. Restoring text holds the loading guard until the editor update completes, so programmatic restoration is not mistaken for a user edit.

Rendered tests cover failure visibility and a successful retry action. An isolated native test also verified a failed draft service, Retry loading draft, restored text, and both conflict-resolution choices.

## Window close

A persistent Shell keeps its native window and editor entities alive while saving its layout and every draft retained by its DockHost, including inactive tabs. It removes the window only after the persistence fence and the explicit `window.close` command both succeed. A failed save shows an error with **Retry save and close** and **Keep working** actions. Retry resubmits retained drafts even when their text has not changed. Edits made while a close is waiting require another save cycle before removal. A pending draft load or Agent action keeps the window open until the user retries.

An untouched empty draft at revision zero needs no save. Skipping that payload does not
acknowledge retained edits or clear failed-save fences. An intentionally cleared draft at a
positive revision still saves. A native fixture verified initial draft loading and successful
window closure with an untouched empty editor after both lifecycle fixes.

DockHost passes its owning Shell window ID into every chat editor before construction. Draft save, restore, and close retry therefore use the same stable window-and-conversation identity across pane recreation and workspace switches. Draft restoration prefers newer retained or local revisions over a delayed daemon response. A save acknowledgement with different text or revision is treated as a conflict, preserving the unsaved payload instead of claiming it was stored.

ClientState retains the latest unacknowledged `draft.save` payload for each window and conversation before queue admission, including attachment metadata. Removing a pane or switching workspaces does not release these payloads. Closing the window resubmits its retained payloads before waiting for the fence. Older acknowledgements cannot release a newer payload, and an older draft revision cannot replace a retained newer revision. Successful acknowledgement releases the retained payload.

Retention is in client memory, with one latest payload per unsaved draft. It protects pane and workspace teardown, but does not provide crash recovery for changes that never reached the daemon. Failed saves must still be retried before quitting the client process.

`close_tests` exercises the production completion helper in a rendered GPUI window: a failed save preserves the original window and input text, a changed draft prevents removal, and only an unchanged successful save permits removal. Native checks verified retention after a failed save and successful Retry save and close after reconnecting.

## Admitted attachment imports

Once an import begins, its completion task retains the originating editor until it
has merged the results into that Conversation's draft and admitted the draft save.
Closing a pane or switching workspaces does not discard that result. The task
releases the editor after completion; it does not select or reopen the old pane.
The existing draft conflict checks protect edits made in another pane.

The shared client counts pending draft actions by window. `DraftAction` covers
attachment imports and prompt acknowledgements. Window close waits for all of
that window's actions, including those whose panes have closed. Once the count
reaches zero, the normal persistence fence covers their admitted saves. Actions
in another window do not block this window. Each request uses bounded command
admission and transport deadlines; a batch contains at most eight requests.

The file picker itself remains view-owned. Closing its editor before the user
chooses files discards that unsubmitted choice. Admitted imports are not durable
jobs across application crashes; forced termination can still interrupt them.

## Prompt acknowledgement ownership

Submitting a prompt synchronizes its editor text into the local draft before
capturing the submitted revision. The acknowledgement task retains that editor
until completion and holds a `DraftAction` guard for its window. An accepted
submission clears and saves only the matching revision, text, and attachments.
A newer local draft survives a late reply. Rejections and unconfirmed results
preserve the draft and report the error without replaying the request.

Releasing the pending action and saving its draft clear do not require a native
window. Selection and composer presentation still update only a live view.
Other conversation actions retain weak view ownership; admitted daemon commands
continue independently, while results cannot force a superseded selection.
Forced application termination before acknowledgement or save is still outside
this in-memory ownership guarantee.

## History and child transcript reads

Older history pages and child transcripts use the bounded disposable-read pool.
Workspace owns each read guard. Replacing a read, choosing Latest, closing the
child reader, changing Conversation or workspace, and dropping the editor release
the relevant guard and shut down its client read socket. A provider-side child
read that the daemon already admitted may still finish; no mutation is replayed.
Generation and Conversation checks reject superseded completions.

History conversion runs on the background executor. An older page belongs to its
editor and is not ingested into the shared latest-message projection. A failed
read retains the visible page and exposes an explicit retry with the original
page boundary. Success clears that error. Child read failures also expose retry,
and opening a different child clears the previous child's page-navigation stack.

## Tool disclosure

Each Workspace owns its expanded tool-message IDs. Switching Conversations clears them;
streaming updates and list virtualization do not. Tool input/output is rendered only while
expanded, in literal code blocks with a UTF-8-safe 16 KiB preview and bounded scroll area.
Copy actions use the complete payload, with an explicit notice when the preview is limited.
The presentation does not rewrite tool messages or their status. Failed summaries remain
visible while collapsed. Paseo's compact overview and bounded details area informed this
design (`packages/app/src/tool-calls/detail-level/overview/view.tsx`, evaluation revision
`c356394bfa127832350c0535d32f5511bc86523c`); the lux-ade implementation is original Rust code.

## Conversation actions and request controls

Conversation actions capture the current draft generation, workspace, and Conversation
before submission. A delayed create/open response only changes selection if those values
still match. A closed response channel releases the pending action and reports an uncertain
result; it does not replay the operation. The rendered regression injects both a late
workspace result and a closed channel into the actual completion path.

Approval and question forms live in `request_ui.rs`. Workspace owns their inputs and
subscriptions until the requests disappear. Selected Codex multiple-choice labels travel
as separate array entries. A manually edited answer remains one string; commas are never
used to infer multiple values. Other provider adapters retain their existing string contract.
Approval and diagnostic text use a selectable literal preview limited to 8 KiB, with explicit
truncation and a copy action containing the complete unmodified text.

## Disposable pane reads

Review status, diff, and operation-status reads, worktree status reads, and service-list reads use a view-owned `ReadRequest`. Dropping this guard shuts down its socket, including an in-progress hello, and cancelled queued reads stop before opening a connection. The allowlist rejects mutation operations. Service mutations cancel an obsolete refresh; existing generation checks prevent that refresh result from changing the new operation's UI state.

Review, service, and worktree requests now use bounded worker admission instead of per-request OS threads. Admitted Git/worktree/service mutations continue when a pane closes, and their result is discarded when the view no longer exists. Closing a progress view does not cancel the underlying operation.

## Remaining boundaries

Discovery and local connection establishment may take up to their five-second deadline before a cancelled read exits; the guard interrupts established sockets immediately. Follow-up catalog/service reads inside an admitted mutation chain still complete under the chain's existing individual RPC deadlines. Native terminal creation uses the bounded mutation pool; other callers outside these three manager views have not all been migrated to disposable reads. The fixed workers live for the client process lifetime and idle on condition variables; they do not own provider processes. Flush admission does not create waiter threads; the queue remains bounded to 128 ordinary pending jobs plus 16 reserved fences.

Controller helpers use bounded stdout capture and discard stderr contents. Discovery has a five-second deadline; automatic startup has forty seconds; status has twenty seconds; explicit recovery actions have sixty seconds. Timeout kills and reaps only the immediate controller process, never its process group or a daemon it started. The client then reconciles runtime state instead of automatically replaying an uncertain action. Socket discovery caches only success, so a transient failure does not permanently redirect the client to a legacy endpoint. The compatibility `socket()` string accessor returns an empty unresolved path on failure; connection and recovery operations use the fallible resolver.

## Verification

`client_state::tests` checks idle-subscription destruction without process-stop traffic, bounded admission, byte budgets, draft revision ordering, save coalescing, close boundaries, and flush fences. The same tests cover malformed event atomicity, stale-state protection, first-catalog initialization, slow-drip response deadlines, and sticky persistence failure recovery. Additional client tests prove that disposable reads reject mutations, dropping a read guard interrupts its socket, queued cancelled reads fail before transport, and dropped mutation receivers do not cancel admitted work. Platform tests cover controller deadlines, output bounds, surviving descendant processes, and local socket connection deadlines.

## Review completion ownership

The Changes view owns its response task as well as its disposable read guard and
polling task. Destroying the view drops the completion receiver immediately; an
unfinished reply does not retain a detached UI waiter. Replacing the response task
releases its previous waiter. Admitted Git mutations still execute in the bounded
command pool and are not cancelled by dropping their UI receiver.

A rendered regression starts the production completion path, closes its window,
releases the entity, and verifies the producer sees a closed response channel.
Restoring detached completion leaves that channel open and fails the same check.
The existing lost-response regression still verifies pending-state cleanup while
the view remains open.

## Services and Worktrees completion ownership

Services owns its current response task. A mutation superseding a status refresh
releases that refresh's waiter and read guard. Generation checks still reject stale
results. Worktrees owns separate tasks for lifecycle responses and workspace-open
responses, so one does not replace the other. Closing either manager releases its
response receivers and disposable reads; admitted mutations continue in the bounded
worker pool. Catalog reconciliation already admitted by a workspace open also
continues, but a closed manager cannot open a late native window.

Worktrees accepts one pending workspace open per manager. Repeated Open clicks
leave that request intact, and its Open controls are disabled until completion.
Success, failure, and missing completion delivery release the pending flag.
Rendered regressions close the manager windows and verify response receiver
closure. Additional coverage verifies duplicate Open preserves the pending reply
and a closed reply channel releases the busy state with an explicit error.

## Transcript completion ownership

Each Workspace owns one history completion task and one child-transcript completion
task. Resetting history or closing the child reader drops its task together with
the disposable network read. Replacing a read replaces its completion task. Editor
destruction releases both tasks. History completion owns its background decoding
task, so cancellation releases a pending channel wait as well; a synchronous decode
already executing can finish on its worker. Decoding remains off the UI thread.

Generation and Conversation identity checks remain a separate safeguard against
late results. A rendered regression verifies both history and child response
receivers close on reset and on window/editor destruction. The history error,
retry, and stale-generation test deliberately keeps a completion alive while
advancing its generation, proving the guard independently of cancellation.
Admitted prompt and attachment operations keep their existing stronger ownership;
this cancellation policy applies only to disposable transcript reads.

## Draft completion ownership

Workspace owns separate draft-load and conflict-resolution completion tasks.
Starting draft loading releases its old load task before checking an empty selection
or a cached draft. Replacing a load or resolution replaces that completion task;
destroying the editor releases both response receivers. Captured owning-window
handles remain necessary for constructor-time responses and window transitions.

Changing selection does not discard an admitted conflict-resolution completion:
it still releases pending UI state, while generation and Conversation checks
prevent its text from replacing a newer selection. Persistence workers own the
accepted draft commands independently of these response receivers. Dropping a UI
completion does not cancel a draft save, resolution, or ordered draft read.

The rendered owning-window regression now checks waiter disposal for loading and
resolution, as well as obsolete loads released by cached restoration and an empty
selection. It retains its existing checks for constructor-time restoration,
stale-resolution rejection, and current-resolution application.

## Shortcut settings

Shortcut saves execute on GPUI's background executor. One admitted save spans the disk write and native-menu application across all windows; a concurrent attempt returns a visible retry message. Closing the settings panel does not cancel an admitted write. If that write fails after the panel closes, the shared client error retains the failure. While saving, the panel disables edits and repeated saves. Panel and startup reads also run on the background executor, as described below.

## Installed first launch

The packaged controller does not set `ADE_ROOT` to bundle Resources. Without an explicit
root it enables folder selection: the daemon restores durable state but does not create a
workspace or a default terminal. The client restores saved windows for non-bundle workspaces,
or presents a native folder picker when none exist. Opening a folder uses `workspace.open`;
the catalogue subscription then opens the workspace. Development launches and explicit
`ADE_ROOT` overrides retain their previous behavior.

Legacy bundle Resources records remain in the database and catalogue. Automatic restoration
skips those roots and their saved windows unless `ADE_ROOT` explicitly overrides selection.
This is a non-destructive startup policy, not a database migration.

## Draft conflict recovery

A draft save acknowledgement must match the submitted revision, text, and attachments.
When another editor wins, the client retains both the saved draft and local draft and
blocks automatic save retries for that draft. Equal-revision local edits also retain the
other payloads even when pending writes coalesce. The composer offers explicit Keep this
draft, Load saved draft, and recovery choices for those other local drafts.

Keeping a draft advances the highest observed revision with overflow checking and compares
the saved revision under the daemon store lock. An intervening writer refreshes the conflict
instead of being overwritten. Loading saved text reads again and clears retained text only
if the local submission sequence has not changed. Neither choice lowers the editor revision.
Resolution jobs are persistence barriers; successful resolution clears that draft's failed
save fence. The choices and alternative payloads remain client-memory state until resolved;
an application crash can still lose text that never reached durable storage.

## Shortcut panel reads

Opening Commands or Keyboard shortcuts creates the panel before reading its settings file. The read runs on GPUI's background executor. Shortcut editing, reset, and save remain disabled while loading; command execution and closing remain available. The panel owns its completion task, so closing it discards the result instead of updating another panel. A filesystem read already executing may finish on its worker after closure. This change does not add a filesystem timeout.

## Startup shortcut read

Startup installs default shortcuts immediately and reads saved settings on the background executor. The App owns the completion task; the task holds only a weak client reference for reporting errors. Application teardown drops its completion task. An already executing filesystem read can still finish on its worker.

A successful settings save advances the native-menu application generation. A delayed startup result cannot replace that save or publish a stale load error. If startup completes while a write is still in progress, startup settings apply first and the successful write applies afterward. Failed writes do not suppress valid startup settings. Ordering checks and native menu application run on the UI thread; no write waits for a startup read.


## Native terminal ownership

Creating a terminal uses the bounded ordinary mutation pool. Closing its pane cancels the
view-owned response task, while an admitted creation still completes. It does not terminate
the supervisor-owned session. Each live terminal subscription retains one dedicated output
worker and its bounded 16-event queue. Connection and first snapshot share an absolute
five-second deadline, including slow streams of partial data. Once restored, an idle terminal
has no read deadline. Pane destruction closes its queue and socket, waking blocked output
and reads without sending terminal stop traffic. Connect cancellation before socket attachment
remains bounded by the five-second connection deadline.


The flush design follows Paseo's `agent-storage.ts` separation of admitted writes and flush
completion, while retaining lux-ade's sticky failure reporting. Unlike Paseo's `allSettled` flush,
lux-ade never treats failed saves as a successful close fence. Regression tests fill both the write
queue and reserved fence slots, check visible overload and failure propagation, and prove that
later saves cannot coalesce across an admitted fence.

## Docked browser navigation

The docked BrowserPanel owns a latest-value navigation receiver. Its native
callback replaces one pending URL and posts a bounded wake-up token. If a token is
already queued, the receiver still reads the most recent URL; native callbacks do
not wait for the UI. `about:blank` startup navigation is filtered before publication.
The owning GPUI task and native WebView close with the pane. Once the receiver
closes, publication stops retaining new addresses.

A burst regression publishes 100 addresses before the UI drains them and verifies
the final address survives. Restoring the former 32-item dropping queue leaves the
projection at address 31. Both browser implementations use the same latest-state transport. Standalone
Workspace browsers each own a `BrowserView` containing their WebView and update
task. URL and title callbacks merge one pending update per browser. Navigation
invalidates the previous pending title; a later title completes that update.
Ignored URLs and empty titles do not displace useful pending state. Closing a tab
retains its native view and task in the existing bounded closed-tab history; eviction
releases both. Updates for a background browser do not change the active address.

Rendered tests exercise two independently owned browser update tasks, verify their
URL/title projections and active address, and confirm that dropping a task stops
later updates. Current executable startup paths use the docked shell. This test
covers the retained standalone update path without claiming a native standalone
window was launched.

## Picker completion ownership

The attachment editor and Startup each own their native picker completion task.
Destroying the view releases its pending picker response waiter. A chosen attachment
batch still enters the admitted-import path, which retains its editor through draft
save admission. Startup's accepted workspace-open command remains owned by the
command pool even if its response task closes. The picker helpers normalize native
response errors before applying UI state; cancellation and empty selection remain
non-error results.

Rendered tests supply pending picker responses through the production completion
helpers, close the actual view windows, and check receiver closure. Restoring
`.detach()` fails both checks. These tests prove UI waiter ownership, not native
panel dismissal; AppKit owns the open-panel presentation itself.

## Remaining detached-work classification

This inventory distinguishes async tasks from detached subscriptions and native
surface methods. It does not claim completion of the global lifetime gate.

| Source | Work and lifetime policy | Remaining verification |
| --- | --- | --- |
| `attachment_ui::receive_attachment_import` | Accepted import retains the editor and its per-window draft-action guard through save admission. | Existing pane-close regression covers this ownership. |
| `conversation_controller::receive_request` | Accepted prompt keeps its editor and draft-action guard through acknowledgement. Ordinary action completion is editor-owned; the bounded command pool independently owns accepted operations. | Rendered disposal and prompt-retention regressions cover both policies. |
| `command_ui::save_shortcuts` | Accepted disk write and native-menu application outlive the settings panel; one process-wide save permit bounds admission. | Existing save ordering and failure tests apply. |
| `shell_ui::request_close` | Admitted save fence and acknowledged window close must finish; the native window remains until completion or a visible failure. | Existing close-fence tests apply. |
| `bootstrap` final-window flush | One App-scoped worker waits for persistence; a newer last-window close advances its generation and requires another fence before quit. Failure opens recovery. | Native repeated close/reopen timing remains unverified. |
| `recovery_ui` client reload | One process-wide reload permit spans persistence flush and process replacement. Closing its panel does not revoke the action. Failure releases the permit and reports the error. | Native repeated-click timing remains unverified. |
| `tabs_ui::open_terminal_command` | Supervisor owns admitted terminal creation. The retained standalone UI response uses the editor-owned action task. | Rendered disposal regression covers the waiter; current executable startup uses the docked shell. |
| `bootstrap` benchmark loops and UI smoke | Development-only tasks last for the benchmark/smoke process. The resize loop stops when its target window closes. | Benchmark control-file I/O is synchronous and must remain outside ordinary UI paths. |
| `shell_ui` and `ui` activation observers | GPUI stores these subscriptions in the window's activation-observer collection; callbacks hold a weak entity. Window destruction releases the collection. | Source checked against GPUI `Context::observe_window_activation`; these are not detached async tasks. |
| `bootstrap` and `ui` window-closed subscriptions | App-scoped event observers cover final-window shutdown and the standalone component studio. | App lifetime is intentional. |
| `native_panels`, `tabs_ui`, `workspace_ui` surface `detach` | Native surface attachment management, not GPUI task detachment. | Native surface ownership has its separate tests and audit. |

## Ordinary action completion ownership

Workspace owns the completion task for an ordinary conversation action or retained
standalone terminal request. Their existing pending gate allows one such action
per editor. Destroying the editor releases its response receiver without cancelling
the accepted command in the bounded command pool or stopping a supervisor-owned
terminal. A still-live editor retains selection checks and pending-state cleanup.

Prompt acknowledgements deliberately remain detached and hold their retained
editor plus per-window draft-action guard through draft-save admission. They are
not stored in the editor's task field, which would couple accepted prompt cleanup
to UI disposal. Rendered regressions check ordinary and terminal receiver closure
on editor destruction and preserve the existing tests for accepted/rejected prompt
completion after disposal, newer-draft preservation, and guard release.

## Reload and final-window admission

Client reload acquires a process-wide permit before admitting its save fence. A
second click is rejected while that flush or replacement is pending, even if a
second Runtime window still shows an enabled control. Shared notifications disable
the visible controls, and failure releases the permit before the error update.
Successful `exec` replaces the process in place.

Final-window shutdown owns one App-scoped flush worker. Each transition to zero
windows advances a generation. Another zero-window transition while a fence is
pending does not spawn another waiter; the worker observes the newer generation
and admits a subsequent fence before deciding whether to quit. It quits only
when the latest fence succeeds and there are still no windows. A failed latest
fence opens recovery instead of discarding unsaved data. The existing persistence
worker still supplies bounded fence admission and sticky save failures.

Admission tests reproduce duplicate reload acceptance and duplicate final-window
workers before these guards, then verify a later retry can start after completion.
They prove the gate transitions and production callback wiring; native timing of
rapid reopen/close and repeated Reload clicks remains a separate verification.
