# Recover per-window conversation drafts

Status: partial recovery and close-guard slices implemented; full F036 remains open
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
cannot confirm acceptance, ADE retains the intent and stays open. Running
Electron/real-daemon E2Es cover a dropped completion reply, an unavailable
reconciliation endpoint, a prompt from an inactive managed profile, manual
Retry and exactly one provider turn. Hidden test windows intercept native
warnings without opening ADE in the user's active macOS Space.

Remaining: draft recall/stash, explicit transfer and conflict UI across
clients, attachments, daemon-crash acceptance and the full F036 specification.
The currently running old ADE process must restart to load the new close guard;
its live pending intent was not inspected or changed by these tests.
