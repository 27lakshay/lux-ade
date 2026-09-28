# 06 — Lane E: client reliability in the SDK

Status: open
Type: task
Label: wayfinder:task
Assignee: none
Blocked by: [01](01-phase-0-foundation.md)

The daemon cannot know about a request it never received, so journals of not-yet-admitted
requests belong to the client. They live in Electron main today, so the CLI and other UIs lack
them. Move them into `packages/client`, which already has the outbox.

## Build

1. Move into the SDK, framework-neutral and with no Electron import:
   - the send journal (`apps/desktop/src/main/send-journal.ts`) and its pipeline
     (`main/conversations/send-pipeline.ts`): prompts held until `draft.send.prepare` proves the
     daemon has them;
   - the Git journal (`main/git-journal.ts`) and the refusal proof (`main/git-refusal.ts`);
   - the storage interface they use; `main/outbox-file.ts` stays in main as the Electron
     file-backed implementation, and the SDK ships a plain Node file implementation for the CLI.
2. Electron main keeps only wiring: it creates the SDK journals with its storage and forwards IPC.
3. The CLI uses the same journals for `ade conversation send` and Git mutations, stored under the
   profile's client directory.
4. Keep the existing in-process tests beside the moved code; move `*.test.mjs` with it.

## Acceptance

- The existing send, restore and Git recovery E2E specs pass unchanged.
- A new protocol E2E: the CLI sends a prompt while the daemon is stopped, the daemon starts, and
  the prompt is delivered exactly once.
- `apps/desktop/src/main` no longer contains journal logic, only wiring.
- Evidence in `.scratch/ade-v1/evidence/lane-e-sdk.md`.

## Comments
