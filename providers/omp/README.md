# Oh My Pi provider worker

`worker.mjs` runs Oh My Pi (OMP) through ADE's public provider worker contract. The runtime launches
it with Bun (`Worker::spawn_omp` in `crates/ade-runtime/src/provider_worker.rs`), because the worker
imports OMP's TypeScript RPC frame sources. The worker owns the native `omp --mode rpc-ui` process and
speaks RPC protocol v2 to it (`transport.mjs`).

Pinned: `@oh-my-pi/pi-coding-agent` 18.3.0 (`omp/18.3.0`). A newer upstream does not change these
semantics until the pin moves and the evidence below is rerun.

## Capability matrix

| Capability | Behaviour | Evidence |
|---|---|---|
| Open and resume | Opens or resumes a native session file; the returned native ID and file must match the opened identity. | `worker-peer.test.mjs`, including its installed loopback case |
| Send | Refused unless a fresh `get_state` shows OMP idle, so prompts are serialized. `prompt` acknowledgement is admission, not completion. | `worker-peer.test.mjs`; protocol and desktop runs |
| Prompt echo | OMP echoes the prompt without a correlation ID. The first user entry with the exact admitted text after that send is linked to the admitted native message ID, so it never becomes a second user message. | `e2e/desktop/omp.spec.ts` |
| Completion | A run's `agent_end` settles the attempt that was current at that run's `agent_start`. A late `agent_end` from an older run cannot settle a newer prompt; a run with no observed start stays unattributed. | `worker-peer.test.mjs`; desktop run |
| Local commands | `prompt_result` with `agentInvoked: false` is local completion (`local_prompt_complete`), distinct from a model turn. | `worker-peer.test.mjs` |
| Stop | `abort`, then a `get_state` sample: scope `session`, termination `unknown`, with foreground, queue count and sample time only when the sample is from the open session. Native `stopReason: aborted` on the run's end confirms the Stop; an idle sample with nothing queued after the abort also ends the attempt as interrupted, because installed OMP 18.4 was observed to go idle without an `agent_end` (live probe, ticket 31). | `worker-peer.test.mjs`; `e2e/desktop/omp.spec.ts` |
| Steering | Unsupported: OMP has no native steer for an identified turn. | Descriptor (`omp::worker_descriptor`) |
| Rewind | Unsupported: OMP branch navigation is not a conversation rewind. | Descriptor |
| Compaction | Native `compact`. | Descriptor |
| Requests | `extension_ui_request` confirm, select, input and editor map to typed choices and questions; withdrawal is native `cancel`; informational UI frames are ignored. Built-in tools (such as bash) run without asking in installed OMP 18.4, so `tool_approval` is declared unsupported; only extension confirmations reach ADE. | `worker-peer.test.mjs` |
| History and child transcripts | Bounded native entry pages and session-local child transcript files. | `history.test.mjs`, `child-transcripts.test.mjs`, `worker-peer.test.mjs` |
| MCP | The profile catalog becomes an ADE-owned extension package (`.mcp.json`) passed with `--extension`; a launch with no servers removes it. | `e2e/protocol/ops3/omp-mcp.spec.ts` |
| Background work | No independent background settlement signal was found in the pinned RPC; background state stays unknown. | Pinned-source review (ticket 07) |
| Managed accounts | Identity and workspace credential sources (`.env`) are checked at launch and before every open and send; Bun runs with `--no-env-file`. | `e2e/protocol/accounts/cli.spec.ts` |

## Evidence kinds

- **Fixture:** `providers/omp/mock-cli.mjs` and `e2e/fixtures/omp_account_cli.mjs` are deterministic RPC peers. Protocol and desktop runs that use them are not installed or live evidence.
- **Installed:** `ADE_OMP_LOOPBACK=1 bun test providers/omp/worker-peer.test.mjs` runs the worker on installed OMP against a local deterministic model endpoint.
- **Live:** `scripts/live_provider_check.py` (`pnpm test:e2e:live omp`) needs credentials and is not part of the ordinary gates.
