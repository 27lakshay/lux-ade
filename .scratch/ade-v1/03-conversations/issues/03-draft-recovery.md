# Recover per-window conversation drafts

Status: partial durable send recovery and close-guard slices implemented; full F036 remains open
Type: implementation ticket
Owner: desktop draft worker, integrated by coordinator
Requirements: F036 (initial slice)
Blocked by: 01-local-conversation

Outcome: Electron main owns a stable window ID for the current window lifetime,
separates drafts by profile and conversation, and saves edits to the Rust daemon
with monotonic revisions. The renderer restores a draft after reload. A send
flushes the draft first; a successful send clears it at a higher revision.
Failed saves surface visibly and keep the window open. Failed post-send clear
keeps visible text and blocks another send until retry.

Recorded evidence: `e2e/specs/desktop-drafts.spec.ts` passed with real Electron,
daemon/runtime and Codex fixture. It restored an unsent draft after renderer
reload, kept a second conversation's draft separate, cleared after an
acknowledged send, and observed one provider turn. The full `pnpm check`
passed 14/14 running-process E2E cases.

Later slices added a durable request ID across send-reply loss and Electron
process restart. Retry reconciles the original ID instead of creating a new
provider turn. The normal Quit and window-close guards now first ask each
pending intent's original profile daemon to complete an already accepted
message. They do not dispatch a new prompt merely to close. If the daemon
cannot confirm acceptance, ADE retains the intent in its send journal. Running
Electron/real-daemon E2Es cover a dropped completion reply, an unavailable
reconciliation endpoint, a prompt from an inactive managed profile, manual
Retry and exactly one provider turn. Hidden test windows intercept native
warnings without opening ADE in the user's active macOS Space.

Remaining: draft recall/stash, explicit transfer and conflict UI across
clients, attachments, daemon-crash acceptance and the full F036 specification.
The currently running old ADE process must restart to load the new close guard;
its live pending intent was not inspected or changed by these tests.

## Repeated pending-prompt dialog (open)

The native “ADE is staying open until the prompt is reconciled” dialog occurred
when Electron had an unresolved send request ID and the owning daemon could not
confirm completion during Quit. Electron now writes an exact, private, fsynced
send journal before saving the draft, preparing the send, or dispatching to a
provider. It records dispatch before `agent.send`, preserves the original
profile, conversation, prompt and request ID across process death, and removes
the record only after confirmed completion or rejection. Retry restores a
journaled draft if the daemon lacks it; it refuses a conflicting revision or
payload. An offline reopen shows pending prompts and their original profile and
request ID. Quit can complete without a native warning once the local record
is durable, even if the profile daemon cannot respond. A missing or unsafe
journal still blocks Quit. The macOS last-window path now finishes a previously
requested Quit instead of leaving Electron headless.

Running Electron/real-daemon E2Es kill Electron before `draft.save`,
`draft.send.prepare`, and `agent.send` reach the daemon. Each restart retries
the original request once and admits one provider turn. Another E2E loses the
completion reply, Quits with reconciliation blocked, reopens offline and
recovers on reconnect without a native alert or duplicate provider turn. The
focused suite passes 10/10. A deliberate temporary reversion of the close
decision makes the Quit E2E fail at process exit; restoring the change makes it
pass. Independent review found no confirmed P1/P2 issue in this slice.

On 2026-09-26, two old visible development Electron processes were still
running; one pointed at a missing Unix socket. That does not prove which
process owned the user's screenshot. Neither process nor any live pending
intent was altered. The fix takes effect when ADE starts from the new build.
If the original profile daemon cannot return, the pending prompt remains
visible for explicit user resolution; ADE does not silently resubmit it to
another profile. Full F036 still needs draft recall/stash, cross-client
transfer and conflict UI, attachments and broader daemon-crash acceptance.
