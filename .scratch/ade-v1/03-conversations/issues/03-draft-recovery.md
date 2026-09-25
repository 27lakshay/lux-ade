# Recover per-window conversation drafts

Status: initial renderer-reload slice implemented; full F036 remains open
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

Remaining: window identity across Electron process crash, draft recall/stash,
explicit transfer and conflict UI across clients, attachments, and failure-path
E2E. A lost `agent.send` acknowledgement leaves the outcome uncertain; the UI
currently creates a new request ID on retry, which could duplicate a prompt.
This must be resolved before claiming reliable retry or full F036 acceptance.
