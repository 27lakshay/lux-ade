# context-attachments

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-3
Worker: Phase 2 round E, context-attachments
Requirements: F033 (prompt context capture), F032 (attachments and media: provider support and pre-dispatch refusal)

## Outcome

`context.capture` turns a file range, a diff hunk, terminal output, a service log tail or a finished browser capture into a typed context node with provenance and size bounds. A text capture becomes one managed `text/plain` attachment, so it travels through drafts, sends, queues, retention and backup unchanged. `context.plan` shows each provider's form for each attachment and every refusal before dispatch. `agent.send` (including queue drain) and `queue.enqueue` now refuse, before anything is recorded or dispatched, an attachment the conversation's provider documents it refuses. No requirement is fully accepted: acceptance needs E2E and UI.

## Operation tiers

- `context.capture`: idempotent command. The request ID names the node and its attachment. A repeat returns the recorded node and never reads the source again. A different source under the same ID is refused. The node row and its attachment commit in one transaction.
- `context.get`: query. Reports `available: false` once an attachment was reclaimed.
- `context.plan`: query. It loads the prompt through the store, so a missing or foreign attachment fails with the existing "attach the file again" error.
- `agent.send`, `queue.enqueue`: unchanged tiers and wire shapes; they gain a pre-dispatch provider check.

## Provider table

| Provider | Image form | Text form | Image limit | Request limit | Source |
|---|---|---|---|---|---|
| claude | image block, base64 | text block | 7,500,000 raw bytes (10 MB base64) | ADE 8 MiB | platform.claude.com vision docs, 2026-09-27 |
| codex | UserInput image, data URL | UserInput text | ADE 8 MiB | ADE 8 MiB | developers.openai.com images-vision (PNG, JPEG, WEBP, non-animated GIF; 512 MB per request) |
| opencode | file part, data URI | appended to prompt text | ADE 8 MiB | ADE 8 MiB | `providers/opencode/session-api.mjs` |
| omp | RPC prompt image | appended to prompt text | ADE 8 MiB | 1 MiB whole frame, measured exactly | `@oh-my-pi/pi-coding-agent` 18.3.0 `MAX_RPC_FRAME_BYTES` |
| other (ACP, executable) | adapter decides | adapter decides | none claimed | none claimed | the adapter refuses undeclared kinds at dispatch |

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-core/src/prompt_context.rs` (bounding, ANSI stripping, line selection, fencing, names, provider plans and refusals), `crates/ade-core/src/contract/context.rs` (tiers, source round trip)

## Verified only statically

The daemon capture paths (file preview reuse, diff token check, terminal and service identity checks, browser capture lookup), the transactional node record, the admission hooks and the CLI `context` commands compile and pass Clippy but were not run against a live daemon.

## Needs E2E or UI later

- F033: capture from each surface in the running app, preview the stored document, send it, restart, and see it restored.
- F032: attach an oversized image to a Claude conversation and an 800 KB image to an Oh My Pi conversation; both must be refused before dispatch with the plan's message.
- The renderer must read terminal selections and service output from xterm.js buffers and pass them as `text`.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 60 | 5 | 8 | 0 |

## References

- t3code @ ade-evaluation-2026-09-24, `apps/server/src/attachmentStore.ts`, studied (attachment ID and extension hygiene); nothing copied.
- Anthropic vision docs, platform.claude.com/docs/en/build-with-claude/vision, fetched 2026-09-27.
- OpenAI images and vision guide, developers.openai.com/api/docs/guides/images-vision, fetched 2026-09-27.

## Open

- Image pixel dimensions are not checked (Claude refuses above 8000x8000 px, and above 2000 px when a request holds more than 20 images). That needs a header parser for PNG, JPEG, GIF and WebP.
- Codex refuses animated GIFs; ADE does not detect animation yet.
- The Claude limit assumes the direct Claude API. Bedrock and Vertex allow 5 MB base64 per image, and ADE does not know which backend an account uses.
- A capture must come from the conversation's own workspace. Cross-workspace context is refused, not supported.
- `conversation.steer` does not run the provider check.
- Terminal and service text is client-supplied. The daemon verifies only that the terminal or service exists in the workspace.
- The `context_nodes` table lives in the conversation store database and is created idempotently. Backup copies it with the database; the backup-coverage slice may want to list it.
- Keep `prompt_context::plan` in step with the four bridges named in its module header; a coordinator may want a shared-file note in `decisions.md`.
