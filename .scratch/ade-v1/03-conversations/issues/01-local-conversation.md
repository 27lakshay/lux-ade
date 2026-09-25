# Local conversation through a primary provider

Status: initial slice implemented; live-provider and full-feature acceptance remain open
Type: implementation ticket
Owner: coordinator
Requirements: F021, F031, F038, F101 (initial daily-use slice)
Blocked by: 02-client-connection

Outcome: select a workspace and primary provider, create a conversation, send
text through the shared daemon command interface, read structured transcript
and pending requests, and retain state across renderer reload. Keep provider
execution in the runtime. Use the existing deterministic Codex fixture for
initial E2E, then separately record live Codex, Claude Code and Oh My Pi results.

Owned modules: Electron conversation view/IPC and its E2E. The CLI worker owns
the shared client command transport; integrate that interface after review.

E2E acceptance: launch real daemon/runtime with fixture Codex, create and send
from Electron, observe ordered user/assistant/tool records, reload and observe
the same IDs without a second provider dispatch; show pending approval and
answer it once. Record unsupported content visibly.

Completion evidence: passing running-app E2E and separate live-provider evidence.
This first slice alone does not complete the full F021/F031/F038/F101 specs.

Recorded evidence: `e2e/specs/desktop-conversation.spec.ts` passed against a
real isolated daemon/runtime and deterministic Codex fixture. It observed
structured tool content, stable message IDs after renderer reload, one native
dispatch, and resolved command approval and Codex native question answers. The
UI currently supports text prompts, native approvals/questions, and the first
200 transcript records. Attachments, pagination, drafts, and broader
live-provider verification remain open. A separate disposable-profile check
passed one real Codex and one real Claude Code text turn; Oh My Pi entered
`error` on this Mac and awaits a configured-account rerun.
