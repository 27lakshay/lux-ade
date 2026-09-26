# Once-only native answer delivery

Status: implemented answer-recovery slice; broader F038/R001/R002 acceptance remains open
Type: implementation ticket
Owner: coordinator; CLI/E2E: `/root/answer_cli_e2e` (finished); independent review: `/root/answer_recovery_audit` (finished)
Requirements: F038, F103, R001, R002 (daily-use answer slice)
Depends on: 01-local-conversation and runtime command receipts

Outcome: Electron and CLI can answer or decline a native request. A lost daemon
reply or daemon crash does not cause a second native answer. Reusing the same
request with different decision or answers conflicts. A proven failure before
native delivery permits a new durable attempt with the same answer. An outcome
that may have reached the provider remains uncertain and is never blindly
replayed.

## Observable E2E acceptance

1. Through a real daemon/runtime, present Codex approval and question requests;
   answer, decline and submit structured answers from CLI/Electron. The native
   peer receives one reply per request. Exact repeats return the recorded
   result; changed decisions and answers conflict.
2. Crash the daemon before runtime admission, after runtime delivery, after a
   definite no-delivery receipt, and after advancing the durable attempt. On
   reconnect, an identical retry returns the surviving receipt or safely
   dispatches the next attempt. A provider-initiated request resolution is not
   mistaken for ADE's answer.
3. Return a proven pre-native error while the provider remains live. Retrying
   the same decision succeeds once and clears its error. Concurrent conflicting
   clients admit only one decision. A native/transport outcome without proof of
   no delivery remains held instead of creating a new attempt.

## Implementation decision and limits

The daemon stores a canonical SHA-256 fingerprint of the decision/answer
payload, not the answer text. It commits that intent before runtime dispatch.
The runtime owns one receipt key per request and attempt. A typed `AnswerNotSent`
receipt is produced only before calling the native adapter; the daemon may then
advance the durable attempt and retry the exact same payload. Generic native
errors and transport loss do not advance the attempt. A native `Resolved` event
can end the request, but it cannot prove ADE delivered the selected answer.
Codex's local reply write does not prove the provider accepted it.

Implemented in `1e1b36a`. Eleven focused running-process E2Es pass, including
the Electron approval/question cases, CLI answer/decline, and recovery cases.
The integrated source suite passed 162 E2Es with one host-filesystem skip;
the rebuilt macOS app passed all six packaged E2Es. Rust formatting, strict
all-target Clippy, TypeScript checks, Fallow, and builds passed. Independent
review found no confirmed P1/P2 defect after the recovery fixes.

This slice is deterministic-provider evidence for the shared answer boundary.
Real Claude, Codex and Oh My Pi answer flows, complete native failure modes and
full F038/R001/R002 acceptance remain open. The initial `AnswerNotSent` proof
path is an E2E fault injection at the runtime boundary; native adapters must
never label an ambiguous write or timeout as definite no-delivery.
