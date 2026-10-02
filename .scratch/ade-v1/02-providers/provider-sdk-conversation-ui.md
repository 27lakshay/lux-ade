# TypeScript provider SDK and conversation UI

Status: ready-for-agent
Type: specification
Scope: ADE v1; detailed delivery specification for providers, conversations and their extension points
Decision date: 2026-09-30
Implementation status: unverified against this specification; existing headless acceptance does not establish SDK parity or a built conversation UI.

## Problem Statement

People need to work with several agents in ADE without losing native features, approval choices, account identity or confidence about whether work actually ran. A common text stream is insufficient: providers differ in how they admit input, steer work, cancel queued messages, finish turns, run background tasks and restore sessions.

Provider authors need one documented contract that lets them add an agent without editing ADE core. Today, the internal provider interface and the installed worker interface expose different capabilities. A third-party worker cannot implement every feature available to a bundled adapter. The production desktop has a conversation projection but does not yet render conversation pane content.

Building a complete speculative UI before exercising real adapters would hide these differences. Building every adapter first would defer the interaction and recovery problems that only appear in the desktop. ADE needs both surfaces developed together against observable behavior.

## Solution

Build a TypeScript provider SDK using Effect v4 RC and a production conversation UI that consumes ADE's authoritative daemon state. Extend the Rust-owned contracts where needed, generating the matching TypeScript wire types and validators. Keep provider processes and recovery under the Rust runtime and durable application rules under the daemon.

Use native integrations for Codex, Claude Code and Oh My Pi. Offer a generic ACP integration for compatible agents, with explicit capability limits. Prove the same public authoring contract with an independently installed provider and optional UI contributions before freezing it. Configuration alone is sufficient only when an existing protocol adapter already supplies the required behavior.

Users receive a consistent conversation experience without fabricated provider parity. They can see delivery, execution, background activity, synchronization and uncertainty; answer native requests; inspect tools and child activity; recover drafts and readable history; and retain control during failure. Authors implement native behavior while the SDK handles worker communication, validation, scoped resources and contract conventions.

This specification refines F021–F043, F046, F049–F050, the conversation-facing portions of F051–F060 and R001–R020. It does not broaden excluded v1 products or certify previously accepted backend features against the new desktop requirements.

## User Stories

1. As a user, I want to choose Codex, Claude Code or Oh My Pi for a conversation, so that I can use the agent that fits my work.
2. As a user, I want to install another provider without rebuilding ADE, so that I can adopt a new agent independently.
3. As a user, I want to configure an ACP-compatible executable, so that I can connect an agent already supported by the generic adapter.
4. As a user, I want unsupported features to have an explanation, so that I can distinguish a provider limitation from an ADE failure.
5. As a user, I want temporarily unavailable features to show their current reason, so that I can resolve authentication, quota or readiness problems.
6. As a user, I want to see which workspace, host, provider and account context a conversation uses, so that I know where work will happen.
7. As a user, I want account identity to remain fixed during credential refresh, so that my work does not move to another account.
8. As a user, I want to switch accounts only through an explicit supported action, so that continuity limits are clear.
9. As a user, I want model, reasoning and permission options to come from the selected provider, so that I choose settings it supports.
10. As a user, I want to see effective settings after applying a preset, so that hidden conflicts do not change my intent.
11. As a user, I want to send a prompt and keep its durable submission identity, so that reconnecting cannot duplicate it.
12. As a user, I want to distinguish local admission from provider acceptance and execution, so that queued work does not look like running work.
13. As a user, I want text to stream in order, so that I can read a coherent answer while the agent works.
14. As a user, I want visible reasoning content where the provider exposes it, so that I can inspect available context without invented hidden reasoning.
15. As a user, I want tool inputs, output and status to appear as structured content, so that I can understand what the agent did.
16. As a user, I want to expand large tool output on demand, so that the conversation stays readable and responsive.
17. As a user, I want child activity and supported child transcripts, so that I can follow delegated work with its provenance.
18. As a user, I want command and file changes to link to the relevant ADE resource, so that I can inspect their consequences.
19. As a user, I want a yielded prompt to remain distinct from a settled session, so that background work is not hidden.
20. As a user, I want autonomous output to remain visible and attributed, so that work without a fresh user prompt does not disappear.
21. As a user, I want to queue follow-up prompts and inspect their state, so that I can prepare work without confusing it with execution.
22. As a user, I want to remove a pending prompt when removal is supported, so that unwanted work does not start later.
23. As a user, I want native steering to target the current turn, so that redirection is not silently converted into another prompt.
24. As a user, I want a stale steering request to fail clearly, so that it cannot target a successor turn.
25. As a user, I want Stop to show the scope it can stop, so that I understand whether queued or background work remains.
26. As a user, I want requested cancellation and confirmed stop to appear separately, so that a transport acknowledgement does not mislead me.
27. As a user, I want Stop to remain reachable during heavy output or storage failure, so that I can regain control.
28. As a user, I want to see every native approval choice with its duration and scope, so that ADE does not widen a permission grant.
29. As a user, I want to answer structured questions with their validation rules, so that the agent receives a valid answer.
30. As a user, I want resolved, withdrawn or expired requests to stop accepting answers, so that late clicks cannot authorize unrelated work.
31. As a user, I want an uncertain answer delivery to remain reconcilable, so that I do not grant permission twice.
32. As a user, I want to preview attachments and captured context before sending, so that I know exactly what the agent receives.
33. As a user, I want unsupported attachment types and limits checked before dispatch, so that a failed send does not consume my draft.
34. As a user, I want drafts to survive a window crash, so that unfinished work remains recoverable.
35. As a user, I want explicit draft ownership and transfer between clients, so that another window cannot overwrite my input.
36. As a user, I want recall and stash to preserve text and context references, so that I can reuse unfinished prompts.
37. As a user, I want provider commands and skills to disclose how they run, so that local commands and model prompts are not confused.
38. As a user, I want supported context compaction to retain its native evidence, so that I know what changed.
39. As a user, I want a rewind preview to distinguish conversation history from file restoration, so that I can understand its scope.
40. As a user, I want a new native session created by rewind to retain lineage, so that ADE does not silently replace identity.
41. As a user, I want long histories to load in pages, so that older work does not make a conversation unusable.
42. As a user, I want my reading position to survive history loading and delayed content, so that the view does not jump.
43. As a user, I want to distinguish connected from caught up, so that I know whether displayed state is current.
44. As a user, I want restored history to merge with live output without duplicates, so that reconnecting preserves one timeline.
45. As a user, I want to read retained history when a provider is unavailable or removed, so that my work remains accessible.
46. As a user, I want imported sessions to disclose whether they are resumable, so that readable history does not imply execution continuity.
47. As a user, I want unknown execution outcomes shown honestly, so that I can investigate before creating duplicate effects.
48. As a user, I want closing a tab or window to preserve runtime-owned work, so that a view's lifetime does not control an agent's lifetime.
49. As a user, I want old callbacks fenced from newer execution attempts, so that reconnecting or cancelling cannot corrupt later work.
50. As a user, I want provider updates to preserve leased executions, so that an upgrade does not replace code under active work.
51. As a user, I want missing custom renderers to fall back to readable core content, so that plugin failure does not hide history.
52. As a user, I want pending requests and recovery controls in safe mode, so that I can act when an extension fails.
53. As a user, I want reported usage and quota data to include units, source and freshness, so that missing values do not become invented billing figures.
54. As a user, I want keyboard navigation, accessible request forms and reduced motion, so that I can use the conversation comfortably.
55. As a user, I want text selection and copy to work while streaming, so that output updates do not disrupt reading.
56. As a user, I want responsive conversations while other agents produce output, so that one busy resource does not stall the desktop.
57. As a user, I want attention and unread to remain separate, so that a new reply does not necessarily mean the agent needs me.
58. As a user, I want existing search, export and backup actions to remain available, so that the new surface preserves access to retained work.
59. As a provider author, I want a typed TypeScript adapter interface, so that I can implement native behavior without learning ADE's Rust internals.
60. As a provider author, I want worker framing and RPC handled by the SDK, so that I can focus on the provider integration.
61. As a provider author, I want scoped resources and typed failures, so that sockets, subprocesses and event readers have predictable lifetimes.
62. As a provider author, I want to declare capabilities, limits and schemas, so that ADE presents only valid operations.
63. As a provider author, I want native and namespaced extension events to retain provenance, so that normalization does not discard meaningful features.
64. As a provider author, I want to implement the same operations as a bundled provider, so that installation does not reduce feature fidelity.
65. As a provider author, I want optional timeline and composer contributions separate from backend code, so that my provider also works headlessly.
66. As a provider author, I want a conformance harness with failure scenarios, so that I can demonstrate my declared guarantees.
67. As a maintainer, I want one Rust-owned wire definition with generated TypeScript output, so that incompatible handwritten definitions cannot drift.
68. As a maintainer, I want native-provider evidence separated from fixture evidence, so that simulated support is not reported as real compatibility.
69. As a maintainer, I want the primary three and an independent installed provider exercised before contract freeze, so that extensibility is demonstrated rather than assumed.
70. As a maintainer, I want each provider-and-UI slice measured and accepted as it lands, so that correctness and performance are not postponed until the app is complete.

71. As a user, I want immediate startup output retained, so that a fast agent cannot lose its first response before ADE begins reading.
72. As a user, I want partially applied settings reported accurately, so that a failed model or permission change does not hide the settings actually in use.
73. As a user, I want approvals and terminal tool outcomes displayed after preceding output, so that batching cannot scramble the meaning of a turn.
74. As a user, I want temporary history read failures to preserve identified stale content, so that a connection problem does not look like deleted work.
75. As a user, I want tool results whose calls fall outside the loaded page identified clearly, so that pagination cannot attach results to an unrelated tool.
76. As a user, I want work admitted during cleanup retained, so that stopping one execution cannot silently discard its successor.
77. As a provider author, I want version-matched Effect guidance and focused diagnostics, so that common resource and error-handling mistakes fail before packaging.
78. As a maintainer, I want reference patterns evaluated against ADE's guarantees, so that useful examples do not introduce unbounded buffers or weaker effect admission.

## Implementation Decisions

### 1. Ownership and module boundaries

1. The Rust core owns typed wire requests, replies, events, errors and operation tiers. Extend the existing contract generator to cover the provider worker boundary; generate TypeScript types, JSON Schema and validators rather than maintaining a second authority.
2. Build `@ade/provider-sdk` as an ESM TypeScript package. Its main authoring API is framework-neutral and Electron-independent. Its testing entry point supplies conformance support without bringing a runner into production workers.
3. The Rust runtime owns worker supervision, execution attempt identity, native process ownership, command deduplication, event sequencing, bounded delivery and runtime attachment. The daemon owns durable records, admission, receipts, account binding and the change feed.
4. The application client SDK remains the desktop/CLI interface. The provider SDK serves adapter authors and runs behind the runtime; it does not replace the client SDK.
5. Build conversation pane content around the existing conversation projection, typed preload and stream bridge. No renderer imports of native SDKs, provider subprocess code, credentials, Electron or Node APIs.
6. Keep provider-specific branches inside adapters and declared contributions. Core widgets act on capabilities and typed data rather than provider-name switches.

### 2. Effect adoption

1. Use the latest Effect v4 RC at implementation start, resolved through the npm `rc` tag and pinned exactly with pnpm. The verified planning baseline on 2026-09-30 is `effect` and `@effect/platform-node` at `4.0.0-rc.118`. Recheck before installation and record a deliberate version change. Do not use an untagged install, which currently selects Effect v3.
2. Use Effect for the provider SDK's typed asynchronous operations, services, scoped resources, concurrent event reading, bounded queues, interruption and tracing. Use the matching Node platform package only in Node entry points. Resolve a single compatible Effect instance within each worker artifact.
3. Adapt Promise and callback SDKs at the adapter boundary. Provider authors need not rewrite upstream SDKs. Errors remain typed until they are serialized into contract errors.
4. Consult the agent guidance shipped by the installed Effect package and its version-matched source. Official Effect skills and the upstream agent guide were found during research; their availability does not authorize installation in this specification task.
5. Effect does not own ADE receipts, durable execution state or recovery. Its retry machinery must not replay effect commands. Interrupting an Effect fiber does not prove that native execution stopped.
6. Generated wire validators remain authoritative. Effect Schema may validate native provider inputs and adapter-internal models; it must not introduce a competing handwritten ADE wire schema. Existing renderer validation and state libraries remain in place.
7. Do not migrate the entire client SDK or renderer to Effect. React consumes the existing client projection and commands. Optional Promise conveniences may wrap the same SDK implementation; they must not create a second lifecycle or execution path.
8. Keep the worker boundary on the existing JSON-RPC-over-stdio transport. Standard output contains protocol frames; diagnostics use bounded, sanitized standard error. Effect organizes its implementation without requiring the Rust runtime to implement Effect RPC. Bound request concurrency, physical/logical frame sizes and partial-frame lifetimes; malformed correlation or framing fails explicitly.

#### Effect implementation patterns

1. Use ordinary `Context.Service` and `Layer` boundaries for native transport, event reading, configuration and diagnostics. Bind dependencies once when constructing a service. Keep pure parsers and transformations synchronous. Use `Effect.gen` for effectful composition and named `Effect.fn` at useful traced boundaries; avoid a span for every token or a service lookup inside each hot-loop iteration.
2. Create one `ManagedRuntime` for each runtime-owned worker instance. Scope session resources beneath it. Promise and AsyncIterable conveniences use this same implementation and bridge cancellation explicitly. Do not create a runtime per operation, use process-global account context or leave subscriptions and fibers detached from an owner. Dispose the runtime when its worker instance ends, independently of any desktop view.
3. Acquire sockets, child processes, readers and subscriptions with scopes and finalizers. Preserve expected typed errors, defects and interruption as distinct causes until translating the worker reply. An intentional stop, shutdown and transport failure have different reconciliation consequences. Avoid catch-all recovery that turns any cause into successful completion; diagnostics retain a sanitized underlying error.
4. Acquire an event subscription before publishing readiness or issuing a native command. Constructing a lazy stream and scheduling its reader does not prove acquisition. Use an explicit acquisition/readiness barrier. Cleanup fences callbacks before releasing resources; a delayed read or unsubscribe completion cannot emit into a successor instance.
5. Keep one execution path across Effect and Promise interfaces. Awaiting settlement targets the identified execution through its cleanup; awaiting session idle may include successors. Implement authoritative admission, successor ownership and transition serialization in Rust. The SDK only coordinates its scoped native resources and observations.
6. Use package-scoped Effect diagnostics to detect unexecuted effects, unsatisfied service requirements, accidental `any` error/context channels and conflicting Effect versions. Preserve the existing static gate. When a repeated mistake warrants a custom rule, add a test of the rule. OpenCode's schema-validation and dependency-binding rules are useful examples, not authority to copy its entire lint configuration.
7. Do not port OpenCode's custom service proxy/Layer graph framework, session store or execution coordinator into the SDK. Its first-payload-wins inbox behavior is weaker than ADE's fingerprint conflict rule. Its native interruption recovery is not authorization to resubmit an ADE effect.

### 3. Provider authoring contract

The author supplies a descriptor and a scoped factory for an adapter instance. Instance construction acquires resources but never implicitly submits input. Session handles expose explicit operations; an event reader continues independently of command replies.

| Surface | Required meaning |
|---|---|
| `describe` and capability discovery | Declare identity, compatible protocol versions, operations, limits, configuration schema and extensions. |
| `open` | Create a new native session or explicitly resume the identified one; disclose effective context and execution evidence. |
| `submit` | Deliver one identified submission and report delivery evidence; do not equate a command reply with completion. |
| `steer` | Target an identified active turn through supported native behavior; refuse stale targets and unsupported steering. |
| `cancel` | Declare cancellation scope, report acknowledgement and later report the observed outcome. |
| `observe` | Supply correlated native observations continuously, including autonomous activity and requests. |
| `readHistory` | Return bounded pages bound to a declared snapshot or disclose weaker native consistency. |
| `inspect` and `reconcile` | Return evidence about an identified session or operation, or explicitly report that the outcome remains unresolved. |
| `respond` | Validate and deliver an identified choice or structured answer to an outstanding native request. |
| Optional operations | Support configuration, compaction, rewind, child transcripts, import and MCP according to declared semantics. |
| Lifecycle | Release resources according to an explicit policy; distinguish closing a transport from cancelling work. |

1. An implementation may decline optional observations and operations through typed capability results. Implementing reconciliation means returning an honest result, not guaranteeing that every outcome can be reconstructed.
2. Each effectful call receives the identity already admitted by ADE. An adapter does not create a competing application operation ID or trust a client-supplied fingerprint.
3. Subscribe to native output before delivering a command that can emit events. Buffer or correlate early events without losing them when output precedes the command reply.
4. Validate that resumed identity matches the requested identity. A provider-created fork is an explicit lineage transition with its old and new native handles, never an unnoticed replacement.
5. Keep the public interface small by putting transport framing, correlation, logging, validation and cleanup inside the SDK. A contract includes its timing, ordering, error and lifecycle rules as well as its types.

### 4. Operation tiers and admission

1. Preserve the existing query, idempotent-command and effect-command model. Every public operation and namespaced extension declares exactly one tier in its contract.
2. History reads, capability reads and inspection are queries. Creating a conversation, submitting input, steering, answering, compaction and rewind use effect admission. Draft saves, seen marks and removal of a still-local queued entry remain convergent commands according to their existing contracts.
3. Separate read-only session inspection, transport attachment, native session creation and process launch. A method that can start or mutate native work is not classified as a query merely because its name is `open` or `resume`.
4. Preserve daemon-computed payload fingerprints, durable intent before dispatch and replay of known receipts for the same operation ID and payload. Conflicting reuse fails. Expired or unknown effect outcomes cannot authorize redispatch.
5. Serialize conflicting transitions within a conversation while allowing unrelated conversations to progress. Reserve the control capacity needed for cancellation, rejection, health and shutdown under overload.

### 5. Identity and execution context

1. Pin host, profile, workspace, provider installation, adapter artifact and digest, account context, launch configuration revision, native home/state location and protocol selection for an execution attempt.
2. Correlate observations with runtime incarnation, attempt generation, session and applicable native turn, submission, item, tool, child or request identity. Preserve native IDs separately from ADE IDs.
3. Native turn IDs may be absent or arrive later. Do not substitute an ADE submission ID and claim it is a native turn ID. Keep many-to-one correlations where native input batching or folding occurs.
4. Autonomous activity may have no user submission. Attribute it to the session and execution attempt, with a native cause when available, rather than inventing a user message.
5. Start with the current isolation of one runtime-owned provider instance per execution attempt. Broader account- or host-level process sharing is deferred until a real adapter requires it and its failure/account isolation is proven.

### 6. Capabilities, configuration and availability

1. Preserve the existing support vocabulary: supported, native-only, unsupported and unknown. Add structured semantics and limits where a capability name alone is insufficient.
2. Keep support separate from current availability. Authentication, executable compatibility, account entitlement, quota, session state and native readiness can make a supported operation unavailable.
3. Version capability snapshots and attach source, observation time and relevant installation/configuration identity. Revalidate before dispatch and reject stale choices with actionable capability errors.
4. Describe attachment types and byte limits, model/reasoning options, settings sources, permission modes, queue ownership, steering semantics, cancellation scopes, history consistency, resume requirements and background activity evidence.
5. Providers return effective settings and native command metadata. Presets are resolved and validated without implicitly changing an account, model or permission scope.
6. Known capabilities cannot be claimed by sending an unrecognized string. New core semantics require a contract change; namespaced extensions use the extension envelope and declared schemas.

7. Apply settings using an explicit dependency plan. For model-dependent mode or reasoning options, apply the model first, rediscover valid options and then apply dependent settings. Serialize conflicting changes and validate the effective configuration revision again before dispatch.
8. Report the effective settings after a partial failure. Native configuration is atomic only when the provider supplies that guarantee. Otherwise reconcile the changes already applied and explain the remaining failure. Do not silently widen permission policy, switch model or fabricate a successful rollback.

### 7. Delivery, execution, activity and synchronization

Track independent facts rather than one overloaded status field.

| Dimension | Facts to represent |
|---|---|
| Delivery | Local admission, dispatch, native acceptance, rejection and unknown delivery |
| Execution | Observed active work, yielded work, terminal outcome and unknown execution |
| Session activity | Background work pending, settled and unknown activity |
| Synchronization | Disconnected, connecting, connected/catching up and caught up |
| User action | Outstanding request, response delivery pending, resolved, withdrawn and expired |

1. Associate each observation with an evidence source: ADE admission, adapter-local queue, native reply, native event, history reconstruction or reconciliation. Include native provenance where available. Derived UI state is not additional native evidence.
2. Preserve cancellation outcome, failure and uncertainty alongside these dimensions. A yielded prompt can coexist with background work. A connected transport can coexist with stale displayed state.
3. The daemon derives the glossary's attention values from authoritative facts. Outstanding requests take precedence over ordinary running indication; unresolved failure remains actionable; idle cannot be inferred solely from transport silence. Unread remains a separate seen-mark calculation.
4. Fence observations from old attempts, accounts, activations and native lineages. Terminal outcomes cannot be replaced by an older partial event, and late cancellation cannot settle a successor.

### 8. Cancellation and queue ownership

1. Distinguish ADE's durable pending queue, an adapter's local input buffer and the provider's native queue. Record when ownership crosses each boundary. Local removal cannot claim to recall an already accepted native message.
2. Expose native steering, follow-up queueing and ordinary submission as different actions. Do not advertise steering by implementing queueing.
3. Cancellation declares whether it targets one active turn, one queued message, all accepted session work or an adapter-supported subset. The UI explains broader escalation and any remaining work.
4. A cancellation reply is acknowledgement. Confirmed stop needs native terminal evidence or runtime-owned process termination evidence with the known scope and limits. Unknown child/background survival remains visible.
5. If native cancellation cannot remove queued input, do not report successful Stop while that input can execute later. Apply a declared safe escalation or retain an unconfirmed outcome. Killing a transport alone is not universal proof of stop.
6. Closing a tab only releases the view. Runtime client detachment, provider transport closure, session suspension and process termination are separate lifecycle actions. Refuse a requested preserve-work closure when the adapter cannot provide it.

7. Retain work admitted while the previous execution is draining or releasing resources. Cancellation and settlement waits remain bound to their original attempt; they cannot consume a pending wake, stop its successor or confuse a session-idle wait with a turn-settlement wait. Output silence alone is insufficient evidence to terminate an instance with known background work.

### 9. Requests, approvals and questions

1. Represent native requests with stable identity, request kind/schema, source session/attempt/turn, revision, creation time, expiry or withdrawal conditions, core summary and validated choice/input schema.
2. Preserve native choice identifiers, labels, scope and duration, including once-only versus persistent grants. Generic accept/decline convenience must not discard native options or widen authority.
3. Answer through existing effect admission. Validate ownership, revision, schema and unresolved state before dispatch. Two conflicting answers cannot both authorize the same request.
4. Persist answer intent and observed delivery separately. A timed-out response remains unknown until evidence resolves it; re-rendering a button does not authorize sending another answer.
5. Resolve or withdraw requests on native evidence, relevant stop or expiry according to declared rules. Late replies are fenced. Unsupported requests receive an explicit safe rejection or actionable unsupported state, never implicit approval.
6. Core UI handles common choice, text, multi-question and permission schemas. Optional custom forms enhance presentation. Missing or failed custom rendering retains the summary and core-supported actions; unknown schemas do not gain guessed controls.

### 10. Events, history and content

1. Keep the runtime's sequence assignment and bounded acknowledged journal. A worker's native cursor is provenance, not authority over ADE's global sequence. Persist a batch before acknowledging it.
2. SDK event transport must be bounded by bytes as well as entries. Do not introduce an unbounded Effect queue ahead of the runtime. Keep command responses and critical control usable while normal output experiences backpressure.
3. Coalesce display updates without discarding durable semantic events. Do not drop tool outcomes, request transitions, errors or delivery evidence to improve frame rate.
4. Retain a core-readable content envelope: stable ID, kind, schema version, status, plain summary/text, attachment/blob references and native provenance. Large native payloads use bounded retained blobs, with retention and redaction rules, rather than unlimited inline JSON.
5. Support incremental text, exposed reasoning, tools, files/diffs, child activity, usage, native notices, compaction and namespaced content. Missing renderers preserve readable summaries and access to retained data.
6. History cursors and live-feed positions are separate. Bind pages to native session/lineage and snapshot revision. Rewind, deletion, account/profile change and expired snapshots invalidate stale work.
7. When an upstream API lacks stable pagination, expose a bounded honest snapshot with its consistency limits or a clear unsupported result. Do not label a truncated collection complete. Remove arbitrary adapter-wide history ceilings only through a supported bounded loading strategy.
8. Define a snapshot/feed synchronization boundary so history and live events merge by stable identity without duplication. ACP replay can arrive before the load reply; completion of that replay is distinct from restoration without history.
9. Fresh connection, replay complete and caught-up display are separate transitions. Overflow or a missing position causes explicit degraded recovery or resnapshot, never a silently complete view.

10. Send the first visible update promptly. Batch subsequent presentation updates only within measured limits and only when they share the same content identity and compatible transition. Flush preceding buffered output before a request, tool completion/failure/cancellation, error or turn boundary. Preserve durable ordering and do not copy Paseo's batching interval as an ADE budget.
11. Keep replay callbacks cheap. Capture identified native updates into a byte-bounded queue or bounded spool, then normalize outside the replay callback. Define an explicit replay/live barrier that handles updates arriving during drain. Queue exhaustion produces declared backpressure or an explicit recovery gap; an unbounded capture list is not an acceptable fix for an upstream SDK's finite notification queue.
12. Key transcript caches by execution/account context, native lineage and resolved source identity, not a native session ID alone. Cache generations include trustworthy source revision evidence and an invalidation epoch. Same-timestamp size changes invalidate file-backed reads; sources lacking reliable revision evidence need another declared validation strategy. Deduplicate only matching reads, and prevent old reads from replacing newer state after invalidation.
13. Distinguish a transient read refusal from confirmed missing history. Retain clearly marked stale data when safe, expose the read error and retry queries with bounded backoff. Do not cache a temporary refusal permanently as missing. Bound retained bytes and decoded memory, including a single oversized transcript; page, stream or report a resource limit rather than exempting the newest entry from the cap.
14. Preserve tool identity and provenance across page boundaries and compaction. If a result's call is outside the loaded page, fetch the identified call where supported or retain readable incomplete context. Do not join by similar text or a reused tool name, silently discard the durable result, or present repeated compacted material as a new tool execution. Child-session activity cannot be attached to a parent turn without explicit correlation.
15. Preserve native timestamp units and source. Normalize documented units; leave unsupported or ambiguous timestamps unknown instead of using a magnitude heuristic as proof. Keep observation time distinct from native event time.

### 11. Recovery, reconciliation and failures

1. Retain existing daemon restart attachment to a live runtime. A daemon outage does not prove provider death. A dead runtime does not prove that every external effect stopped.
2. Represent delivery uncertainty and execution uncertainty explicitly. A worker crash after native acceptance does not restart and resubmit the prompt automatically.
3. Reconcile using identified native state, stable submission evidence, retained receipts and trustworthy history. Finding similar text is insufficient proof of a particular effect outcome.
4. Typed errors distinguish unsupported capability, unavailable feature, stale revision, invalid input, protocol incompatibility, authentication, resource limit, native rejection, transport failure, unknown outcome and adapter defect. Include a sanitized summary, relevant identity and permitted recovery actions.
5. Query retries may use bounded backoff. Effectful operations return known receipts or reconcile; generic retries, host restart and fiber interruption never authorize redispatch.
6. Normal admission stops when durable storage cannot record it. Existing emergency runtime control may attempt to stop work without becoming another application mutation API. Retain unacknowledged events until persistence is possible or an explicit resource failure ends recovery.
7. Provider-native resume may itself continue interrupted work. Declare that behavior, disclose it before resume when applicable and require the explicit operation; do not disguise it as a read-only history load.

### 12. Accounts and installation readiness

1. Extend the public worker context to support managed account execution where the provider supports it. Pass only transient launch material or controlled credential references required for that adapter; never place raw secrets in events, history, receipts, UI or diagnostics.
2. Retain native-owned authentication where appropriate. An ambient login is an explicit account context, not proof of profile-owned isolation. Do not copy an entire home directory as a universal isolation method.
3. Preserve serialized refresh/readback and logout generation fencing. A credential refresh cannot change the account identity or restore a removed login.
4. Revalidate externally managed executables at launch and resume, including resolved location and compatibility evidence. A recorded version cannot prevent an external executable from being replaced.
5. Managed artifacts pin dependencies and helper runtimes. Authentication, installation and version mismatches appear as readiness problems with supported recovery steps. No silent account/model fallback on quota failure.

### 13. Native adapters and ACP

| Target | Integration direction | Mandatory semantic checks |
|---|---|---|
| Codex | Native app-server adapter | Native turn identity, early events, steer target, interrupt acknowledgement versus completion, requests, history and resume distinction |
| Claude Code | Native Agent SDK adapter | Async input ownership, native message correlation, interrupt receipts, pending queue survival, questions, session lineage and bounded history |
| Oh My Pi | Native RPC adapter | Prompt acknowledgement versus completion, local command completion, protocol negotiation, queue behavior, child activity and supported settlement/background evidence |
| Generic ACP | Standard adapter over the official protocol | Negotiated capability scope, load replay barrier, resume without replay where supported, permission outcomes and cancellation/close semantics |
| Independent installed provider | A separately packaged real integration through normal plugin installation | No privileged core changes, declared capabilities, a real turn, failure/recovery and optional UI fallback |

1. Native adapters preserve primary-provider fidelity. ACP expands coverage but does not become the mandatory implementation for native integrations.
2. Require actual installed-version evidence. New upstream semantics are not assumed to exist in ADE's pinned version. Negotiate features where possible and disclose weaker observations when unavailable.
3. The fourth adapter must exercise a real additional integration, not merely rename a fixture or primary provider. OpenCode is the recommended candidate because ADE already has a native bridge that can be exercised through independent packaging; its selection does not establish acceptance.
4. Preserve the existing additional bundled roster decision: OpenCode v2, Gemini CLI and GitHub Copilot CLI have their own declared coverage. This specification does not mark that roster complete or require every adapter before the first vertical slice.
5. No generic model-completion package replaces an agent session protocol. Effect supplies execution infrastructure; it does not supply ADE's native agent lifecycle or durable semantics.

### 14. Extensions and plugin lifecycle

1. Namespaced extensions declare ID/version, input/output or content schemas, operation tier, availability, limits and core presentation metadata. The daemon validates invocation through the same admission model.
2. A new provider using existing operations requires no ADE core changes. A genuinely new semantic operation can use the extension contract, but native custom interaction still requires an author-supplied renderer or the standard fallback.
3. Separate provider/backend entry points from UI contributions. The authoring package does not import React; optional React bindings belong to the UI extension surface. A headless installation does not load UI code.
4. Implement the minimal production UI contribution loader needed for timeline renderers, composer contributions and declared actions. Reuse activation-scoped registry ownership and command conventions rather than introducing another plugin lifecycle.
5. Keep canonical history independent of rendering transforms. Before-admission composer transforms produce validated immutable input and cannot mutate admitted submissions. Side-effect-free transform rules are a trusted-code contract, not a security sandbox.
6. Pin artifact, activation, extension schema and resume/data schema separately. Compatible updates serve new executions while existing executions keep leased code. Reject a data change incompatible with active leases unless it uses a separate namespace or explicit drain.
7. Dispose only a departing activation's registrations. Bound cleanup and avoid author callbacks inside registry locks or storage transactions. Private plugin files remain outside automatic backup guarantees unless registered.
8. Thrown renderer errors use local fallbacks. A frozen renderer uses Electron recovery to create a fresh plugin-disabled renderer. Core history, pending requests, stop/recovery and diagnostics remain available.

### 15. Conversation UI composition

1. Implement production conversation tab content, with header/context, timeline, request/action area and composer. Reuse daemon identity and lifecycle; opening a view does not create an execution attempt.
2. Build the approved conversation surface to its Pen design. Capability-specific or recovery surfaces without an approved design use stock shadcn compositions in the provisional area. Do not invent a replacement visual design in this specification.
3. Reuse the existing Nova/Base UI kit, Graphite theme, typography, icon entry point and command service. Use TipTap for the composer, Streamdown for Markdown, Shiki for code, TanStack Virtual for long timelines and Pierre Diffs for supported diff presentation.
4. Keep query data, durable daemon projections and local interaction state in their existing owners. Selection, focus, expansion, scroll anchoring and mounting policy are local view state; messages, requests, queues and admitted commands are authoritative application state.
5. Multiple tabs can show the same conversation. They share authoritative work without implicitly sharing a mutable draft or view position. Dispose subscriptions on view teardown without stopping execution.

### 16. Composer, queues and context

1. Preserve client-and-conversation draft ownership, revision checks, crash recovery, recall, stash and explicit transfer. Serialize recoverable plain text and context references for plugin nodes; unsupported nodes must remain readable or block sending with an explanation.
2. Preview files, selected text, terminal output, diffs, browser context and media according to the already selected feature scope and actual source availability. Captured context carries source identity and revision; the composer exposes the exact prepared payload.
3. Validate current capabilities, payload size, account context and attachment availability before effect admission. Preserve the draft after rejection or failed admission. Once admitted, associate it with its durable send intent rather than clearing and issuing an unrelated retry.
4. Present Send, Queue and Steer according to actual state and support. A UI shortcut cannot silently choose different delivery semantics. Local slash commands, provider commands and skills disclose their execution path.
5. Explain queue position, ownership, cancellation availability and paused/blocked state. Resolved native queue evidence updates the entry; rendering an entry as absent must not imply the provider recalled it.

### 17. Timeline, attention and recovery interaction

1. Render messages and tool/child activity by stable identity. Show summary-first disclosure for large inputs/output, explicit partial/error/interrupted states and source links where available.
2. Preserve scroll anchors when prepending history or expanding content. Follow new output only while the user chooses the latest position. Provide a new-output affordance when reading older content.
3. Preserve selection and focus during streaming. Expensive parsing/highlighting is incremental or cached per changed item; unrelated rows retain stable references.
4. Show local pending input, provider acceptance, active/yielded work, background activity, cancellation progress and unresolved outcomes with plain labels. Synchronization status is visible when stale state matters.
5. Keep pending requests accessible independently of a collapsed tool row or failed custom renderer. Announce meaningful request/status changes without announcing every token.
6. Integrate existing attention, unread, usage, quota, supported import, search, export, backup and snooze behavior through the application API. This surface does not implement excluded task organization or scheduled agent execution.

### 18. Performance, accessibility and diagnostics

1. Continue using the utility-process stream bridge and per-frame projection publication. Keep high-volume output off ordinary IPC event channels. Terminal output remains outside React state.
2. Virtualize long timelines and cap inline tool/native payload rendering. Bound SDK framing, pending RPCs, event queues, history pages, retained payloads and worker cleanup. Report overflow explicitly.
3. Avoid synchronous filesystem/network work on Electron main or the renderer. Load provider setup and expensive content modules on demand. Suspended views do not perform unnecessary parsing or repainting.
4. Measure each completed vertical slice for cold/warm opening, first visible response, input/Stop latency during streaming, history prepend, reconnect catch-up, concurrent conversations and retained memory after repeated open/close.
5. Establish numeric budgets against a recorded reference machine, workload, artifact and timing method before claiming the performance checkpoint accepted. This planning task does not invent unmeasured thresholds. R019 and the existing resource-budget decision remain open until measured.
6. Follow semantic keyboard navigation, labelled actions, valid request forms, focus restoration, readable contrast and reduced-motion preferences. Test screen-reader announcements and selection under streaming separately from screenshots.
7. Correlate logs/traces by operation, conversation, attempt, native session/turn and activation. Redact secrets and sensitive payloads by default. Capture queue depth, dropped/degraded output, synchronization and cancellation/reconciliation evidence without logging every token or exposing prompts unnecessarily.

### 19. Compatibility and rollout

1. This is a prelaunch contract replacement. Follow the existing no-backwards-compatibility decision: no legacy worker aliases, schema migration chain or dual protocol implementation merely to preserve development artifacts.
2. Still define explicit wire, artifact, extension, resume and data versions. Reject incompatible combinations before use. Version numbers do not themselves promise support for older versions.
3. Preserve leased workers across compatible ordinary plugin upgrades. A breaking prelaunch contract cutover must explicitly drain or terminate affected work with truthful outcomes; it cannot silently hot-swap active execution. Recreating existing profiles is a separate implementation action, not authorized by publishing this spec.
4. Freeze the public authoring contract only after the primary three, generic ACP semantics and a real independently installed integration satisfy declared acceptance. Freeze requires behavior and lifecycle documentation, not just exported types.

### 20. Delivery sequence

| Checkpoint | Work delivered together | Acceptance needed before proceeding |
|---|---|---|
| A. Contract foundation and first slice | Generated worker contract, Effect SDK shell, one native adapter and production text/tool conversation view | Admission, streaming, requests, Stop and readable restart behavior through real ADE processes and desktop |
| B. Semantic stress | Remaining primary adapters, queue/steer distinctions, background/yield evidence and native settings | Provider-specific matrices, cancellation races and loss of delivery evidence |
| C. History and recovery | Bounded history, resume/import lineage, synchronization and draft/context interaction | Long-history/live overlap, stale pages, crashes and uncertain outcomes |
| D. Independent extension | Installable real fourth adapter plus timeline/composer contribution and fallback | Normal installation, no core patches, leases, upgrade/disable failure and safe-mode behavior |
| E. Contract freeze | Authoring documentation, conformance harness, coverage matrix and measured resource policy | Complete declared acceptance, installed/live evidence and honest remaining limitations |

Choose the first native adapter from the simplest existing complete vertical path; Codex is the recommendation because its app-server operations expose useful identities and execution boundaries. Do not treat this as permission to defer Claude/OMP semantics until after interface freeze. Each checkpoint includes reliability and performance work; a completed app is not a prerequisite for measuring them.

### 21. Package selection and developer tooling

Package metadata below was checked on 2026-09-30. These are planning candidates, not installed upgrades. At implementation start, resolve the selected RC once, pin the compatible package set exactly, inspect shipped guidance and declarations, and prove compatibility through ADE's existing gates. A dependency belongs only in the module that uses it.

| Package or module | Decision and purpose | Adoption boundary |
|---|---|---|
| `effect`, `@effect/platform-node` | Required SDK runtime and Node integration; planning baseline `4.0.0-rc.118` for both. | One compatible Effect copy per worker artifact; no renderer migration. |
| `@effect/vitest` | Use for focused Effect tests that need scopes or a controlled clock; planning RC `4.0.0-rc.118` requires Vitest 5. | Development-only. ADE already uses Vitest 5; retain real-process conformance as the acceptance boundary. |
| `@effect/tsgo` | Recommended diagnostics for ADE's TypeScript 7 toolchain; planning candidate `0.47.1`. Its documented toolchain range includes ADE's TypeScript `7.0.2`, Oxlint `1.85.0` and `oxlint-tsgolint` `7.0.2003`. | Verify against the pinned tools and selected RC. Start with SDK-scoped diagnostics; do not silently patch a shared compiler. Existing typechecking remains required. |
| `@effect/language-service` | Official tooling for earlier TypeScript compiler integration. Its documentation directs TypeScript 7 users to `@effect/tsgo`. | Do not add it as a second competing compiler integration in ADE. |
| `@agentclientprotocol/sdk` | Official TypeScript protocol client inside the generic ACP adapter; planning candidate `1.5.1`. | Validate protocol version, native cancellation/replay semantics and its Zod peer dependency. Zod does not become ADE's wire authority. |
| `@anthropic-ai/claude-agent-sdk` | Native Claude integration; inspected ADE pin `0.3.281`, discovered candidate `0.3.285`. | Upgrade only with exact declarations and native/fixture evidence. Preserve streaming input and native session/request behavior. |
| Native Codex app-server and OMP RPC | Retain native protocol integration rather than substitute a model API. Inspected OMP pin is `18.3.0`. | Verify each installed version; newer upstream settlement documentation does not prove the older executable supports it. |
| Ajv and `json-schema-to-typescript` | Reuse ADE's generated Rust-owned wire validation and types. Current pins are `8.20.0` and `16.0.0`. | Effect Schema validates provider-native/internal models, not a parallel ADE contract. |
| TipTap, TanStack Virtual, Streamdown, Shiki, Pierre Diffs and the existing shadcn kit | Reuse the chosen editor, bounded timeline, streaming content, highlighting, diffs and accessible controls. | Existing approved design and component boundaries apply; no additional chat SDK is required for state ownership. |
| `effect/ai`, `@effect/ai-openai`, `@effect/ai-anthropic` | Optional for an actual direct-model feature: typed prompts, responses, tools and streaming. Provider package planning RC is `4.0.0-rc.118`. | Not required for agent-session adapters. V4 core AI APIs are in `effect/ai`; do not copy stale standalone v3 `@effect/ai` examples. |
| `effect/ai/McpServer`, `@modelcontextprotocol/sdk` | Optional implementation tools where a TypeScript component actually owns an MCP endpoint or client; SDK candidate `1.31.0`. | Choose the needed abstraction for that component. Preserve the Rust-owned gateway and native provider configuration; avoid duplicate servers. |
| `effect/devtools` and `effect/observability` | Optional development inspection and OTLP tracing from the selected Effect version. | Scoped, bounded and sanitized; do not capture secrets or full prompts by default. Existing OpenTelemetry infrastructure may justify its matching integration package. |
| Existing property-testing tools such as `fast-check` | Reuse where pure codec/schema invariants benefit from generated cases. | Not another daemon harness or a reason to property-test external effects. |

Effect AI's `Chat` keeps model prompt history inside its service. It is not ADE's durable conversation history, receipt store or native agent session. `LanguageModel`, `Response`, `Tool` and `Toolkit` are useful for direct-model features only. Likewise, an MCP implementation API and a documentation MCP server serve different purposes.

## Testing Decisions

### Test seams and evidence

1. Prefer the two existing highest acceptance seams: the public SDK/CLI/protocol over real daemon/runtime processes for provider behavior, and built Electron over those same scratch backends for user interaction. Share protocol peers and scenarios rather than creating another simulated ADE backend.
2. The author conformance harness runs installed worker artifacts through the real runtime and daemon. It verifies observable contract behavior and reports declared unsupported capabilities. It is not a replacement in-process implementation of the supervisor.
3. Deterministic peers can delay replies, emit early/duplicate/stale events, withdraw requests, lose connections, fill output buffers and crash. They must preserve the daemon, runtime, storage, client SDK and desktop under test.
4. Use focused deterministic tests only for codecs, fingerprints, pure transformations and schema equivalence, plus browser tests for local selection/focus/scroll mechanics that benefit from isolation. Current project testing policy permits these; older domain-spec statements that prohibit every unit test do not override it.
5. Assert external behavior, including durable outcomes, visible state and native protocol effects observable at the peer boundary. Do not assert internal class structure, private queue implementation or implementation call counts. Counting externally received submissions is valid evidence that a retry did not redispatch an effect.
6. Installed-provider, authenticated live, packaged-candidate and performance results remain separate from ordinary deterministic acceptance. Record exact ADE artifact, provider version, adapter digest, Effect version, capability matrix and prerequisites.
7. Missing prerequisites or unsupported optional features are explicit gaps. They cannot produce a passing report that implies native compatibility. Correctness retries remain zero.
8. The proposed seams were presented to the user during specification drafting. No additional interview or new harness is required; any requested seam adjustment must be recorded before implementation.

### Acceptance matrix

| ID | Observable acceptance |
|---|---|
| PC01 | A separately packaged provider installs through the normal plugin path, advertises capabilities, completes a native turn and needs no ADE core source change. |
| PC02 | Every primary adapter uses the public worker/SDK contract for its supported operations; no bundled-only compaction, rewind, child-transcript, account or MCP shortcut remains. |
| PC03 | An incompatible worker or malformed reply fails before unsupported execution; generated Rust/TypeScript validation agrees on accepted and rejected wire fixtures. |
| PC04 | A repeated admitted effect returns its receipt without a second native submission; reuse with a different payload conflicts. |
| PC05 | Native output emitted before the submit reply is correlated once and remains readable after reconnect. |
| PC06 | Local queue admission does not appear as native execution; rejected delivery preserves the draft and its prepared context. |
| PC07 | Native steer targets the active turn; stale targets fail and unsupported steering never becomes a queued prompt. |
| PC08 | Stop during SDK dequeue, native queueing, output flood and successor startup cannot leave undisclosed queued work or stop the successor. |
| PC09 | Cancellation acknowledgement appears separately from confirmed stop; ambiguous native/process outcomes remain unresolved. |
| PC10 | Yielded output with background work remains active as declared; a settled observation changes state only for its own attempt. Older providers disclose unavailable settlement evidence. |
| PC11 | Autonomous output without a user submission is retained, attributed and visible without inventing a user prompt. |
| PC12 | Every native approval scope and question choice survives normalization; invalid, expired, conflicting and stale answers fail safely. |
| PC13 | Lost answer acknowledgement reconciles without a second permission effect; late native withdrawal removes actionable controls. |
| PC14 | Daemon death during an active turn preserves the runtime and provider where supported; reattachment catches up without redispatch. |
| PC15 | Worker/runtime death after submission produces unknown execution where evidence is insufficient; ADE never redispatches the original input implicitly. Native resume that can continue interrupted work is disclosed and explicitly requested. |
| PC16 | Runtime replay and SDK output limits remain bounded; overflow is visible and Stop remains reachable during overload or storage failure. |
| PC17 | Long history loads in bounded pages; overlapping live output appears once; stale snapshots fail rather than mix sessions or lineages. |
| PC18 | ACP load updates arriving before its response merge correctly; resume without replay and close cancellation preserve their declared differences. |
| PC19 | Rewind distinguishes files/history, records new-session lineage when needed and fences old pages/events. Compaction reports real native outcome. |
| PC20 | Two accounts cannot share credential/session state accidentally; delayed refresh cannot undo logout; stale capabilities and changed executables are revalidated. |
| PC21 | Compatible plugin upgrade keeps leased executions on the old artifact and new work on the new one; cleanup cannot unregister the successor. |
| PC22 | Disabled/missing provider UI retains readable history and core-supported pending actions. Thrown and frozen extensions recover through the appropriate existing path. |
| PC23 | The built desktop opens production conversation content and completes send, tools, request, Stop and reconnect flows against real ADE processes. |
| PC24 | Drafts and extension input survive crash/disable, with explicit ownership transfer and readable unsupported-node fallback. |
| PC25 | Unsupported attachments fail before dispatch; captured context preview and actual prepared input agree, including source identity. |
| PC26 | History prepend, streaming and expansion preserve reading anchor, selection and keyboard focus; accessible request forms and reduced motion work. |
| PC27 | Concurrent conversations and repeated view mounting meet the measured latency/resource budgets; a slow consumer does not block unrelated work. |
| PC28 | CLI/SDK and desktop observe the same authoritative outcomes; closing the view does not terminate runtime-owned work. |
| PC29 | Usage/quota displays preserve source, units, freshness and missing values; native/custom content remains readable after renderer removal. |
| PC30 | All mandatory behavior has separate fixture and installed/live evidence for Codex, Claude Code, OMP and the fourth integration before contract freeze. |
| PC31 | A peer emits output immediately after subscription registration and during startup; all output reaches the identified timeline once without sleeps used to hide acquisition races. |
| PC32 | A model change alters valid modes; ADE applies dependencies in order, rejects stale choices and reports effective settings after partial failure without widening permissions or claiming unsupported rollback. |
| PC33 | Burst text followed by requests, terminal tool states, errors and completion preserves visible ordering; presentation batching cannot drop durable transitions or delay critical controls behind unrelated consumers. |
| PC34 | Histories sharing a native ID across different accounts or sources remain isolated. Source generation changes, late reads and transient refusals cannot overwrite newer data or turn an unavailable source into permanently missing history; a single oversized transcript respects declared bounds. |
| PC35 | A paged tool result retains correct provenance when its call is outside the page; compaction replay and child activity do not create duplicate execution or attach output to an unrelated tool. |
| PC36 | Closing a scope or unsubscribing during a pending read produces no late callbacks into a successor. Cancellation and cleanup remain bounded even without an active event consumer. |
| PC37 | Work admitted during predecessor cleanup starts once when eligible; waiting for predecessor settlement and cancelling it cannot consume or stop its successor. Conflicting payload reuse still fails. |
| PC38 | The independently packaged adapter passes the selected RC/toolchain diagnostics and conformance gates. Its Promise/AsyncIterable interfaces preserve the same observable errors, cancellation evidence and resource disposal as its Effect interface, without a second execution path. |

### Prior art and required gates

Reuse ADE's existing daemon-restart, lost-turn, replay-overflow, plugin-provider, activation-drain, artifact-lease, draft/send-intent and conversation-projection scenarios. Extend shared protocol fixtures and built-desktop acceptance instead of introducing parallel fake stores.

Paseo supplies useful native async-input and interrupt/restart cases. Orca supplies unproven-stop and ownership-retention cases. T3 Code supplies typed provider services and separation between adapter behavior and configured provider instances. Agent Orchestrator supplies a distinction between terminal-agent launching and structured conversation drivers. Transfer the behavior and reasoning; copying code requires the repository's licence and attribution rules.

Implementation changes pass static validation and the relevant protocol/desktop acceptance. New tests must be owned by native discovery. Complete integration acceptance uses the ordinary full gate; package, installed/live and performance requirements use their explicit runners. Record failed, skipped and unexecuted coverage beside passing evidence.

## Out of Scope

1. Implementing this specification during its publication, committing, pushing or creating a PR.
2. Moving daemon/runtime ownership to TypeScript, replacing the application client SDK or migrating all React code to Effect.
3. Universal provider feature parity, universal exactly-once external execution, reconstructed private reasoning or guaranteed reconciliation without native evidence.
4. Cross-provider continuation, implicit account/model fallback or automatic retry of an unknown effect.
5. Marketplace distribution, hostile-plugin sandboxing, mandatory support for arbitrary UI frameworks or speculative process sharing.
6. Additional bundled-provider expansion beyond the existing declared roster.
7. Task dashboards, pins/labels/archive UI, scheduled agent execution, automatic settlement and idle hibernation excluded by the v1 scope.
8. Building unrelated browser/file/diff surfaces, remote/mobile clients or orchestration features merely because conversation context can reference them. Existing selected requirements remain separately owned.
9. Legacy development-schema migration or a compatibility layer prohibited by the prelaunch decision.
10. Unmeasured performance promises or declaring acceptance from fixtures alone.

## Further Notes

### Current implementation and remaining evidence

The inspected implementation already has command deduplication, bounded acknowledged runtime replay, persistence-before-acknowledgement, attempt ownership checks and plugin artifact leases. Preserve these guarantees. The current worker recognizes only a subset of internal provider operations, returns bounded whole history and uses ambient native login. SDK parity, managed-account context and paginated history are work to deliver, not existing guarantees.

The current Claude bridge emits a local `started` event before queueing SDK input and rejects histories above an adapter ceiling. The new contract must label the evidence correctly and implement bounded loading where the installed API allows it. Its inspected SDK exposes interrupt receipts; low-level queue cancellation types do not establish a usable public helper.

The current OMP bridge finishes on `agent_end`; its installed package has an older prompt-result shape than current upstream. Current upstream settlement/background semantics are a compatibility target, not proof that the pinned adapter is already defective. Verify the actual version before changing its behavior.

The current renderer has an existing per-frame conversation projection and stable item references, but production conversation tabs render no content. Manifest UI declarations and a command service are not evidence of a complete production UI plugin loader.

Research inspected reference snapshots of T3 Code (`d2c9281b`), Paseo (`c356394`), Orca (`31012aeb`), Agent Orchestrator (`902cefc68`) and OpenCode v2 (`7ef4a1a`). Their broader terminal/provider rosters are not proof of structured conversation parity. No live-provider sessions or previously inspected failure suites were run as part of that research.

| Reference | Useful architecture | Limit on what ADE can infer |
|---|---|---|
| T3 Code | Typed provider adapters and services; configured provider instances have their own lifetimes; native and ACP drivers share normalized events. | Its Effect protocol wrappers are internal workspace packages, not a verified public SDK that supplies ADE's contract. |
| Paseo | A provider client creates/resumes sessions with capabilities and shared stream events; generic ACP coexists with native integrations. | A common event interface does not remove native interruption, queued-input or account differences. |
| Orca | Structured session ownership, journaled delivery evidence and retention of ownership when stop is unproven. | The inspected structured router covers Claude and Codex; the wider terminal roster does not establish structured support. |
| Agent Orchestrator | Separate terminal-agent launch/restore interfaces and structured conversation drivers; native Codex and ACP paths coexist. | Its Go architecture and agent roster are reference patterns, not a TypeScript provider SDK or proof of structured parity for every listed agent. |

No inspected off-the-shelf package supplies ADE's complete agent-session, account, recovery and UI-extension contract. Use official protocol SDKs inside adapters and Effect for asynchronous infrastructure; keep ADE's domain semantics in its own contract.

### Additional source findings and limits

| Source inspected | Pattern retained in this specification | Behavior ADE must not inherit |
|---|---|---|
| T3 provider-instance registry and provider service; ACP connection failure cases | Acquire subscriptions before publishing readiness; drain cancellation output; fence child activity, restarts and late shutdown. Preserve known background liveness. | Unbounded PubSub fan-out, stream construction mistaken for acquisition, or an idle timer treated as proof of settlement. |
| Paseo stream coalescer and interrupt cases | Leading visible event, batched compatible updates, immediate terminal tool transitions and careful post-interrupt attribution. | A copied timing budget, discarded durable events or trailing interrupted output treated as a new user turn. |
| Orca transcript cache and its in-flight/refusal/window tests | Resolved source identity, generation invalidation, concurrent read deduplication, transient-error recovery and teardown fencing. | File size treated as decoded heap size, newest-entry exemptions from memory bounds, or silent deletion of results whose call is outside a page. |
| Agent Orchestrator ACP replay, configuration and cancellation tests | Cheap replay callbacks with later normalization; replay/live drain boundaries; model before dependent mode; bind admitted turn before dispatch; cancellation waits for evidence. | An unbounded replay list, a watermark assumed to be an exact replay boundary, or settings failure silently replaced by a permissive default. |
| OpenCode v2 AI Promise facade, session coordination, inbox and Effect service modules | One scoped runtime for facade methods, explicit cleanup, typed causes, named effect boundaries and separate settlement/idle waits. | Copying its custom service graph, first-payload-wins admission or native restart behavior into ADE's authoritative Rust rules. |

The inspected OpenCode code uses Effect RC `4.0.0-rc.112`; T3 uses RC `4.0.0-rc.115`. Their APIs and examples must be checked against ADE's selected RC rather than mixed unchanged. These findings come from source and test inspection; the reference test suites were not executed.

### Agent resources and documentation workflow

| Resource | Verified use | Limit or required follow-up |
|---|---|---|
| Installed Effect package's `AGENTS.md`, linked `ai-docs` and shipped source | The inspected RC.118 package contains all three. Read the agent guide completely and follow its linked examples for the selected version. | The installed package is the version-matched reference. A rolling GitHub guide may describe a different RC. |
| Official Effect skills | The Effect TypeScript skill directs agents to the package guide; the v3-to-v4 skill is relevant only to a deliberate migration. | Discover and read the relevant skill when implementing. This spec does not install skills or migrate existing ADE packages. |
| Effect v4 API documentation | Check `LanguageModel`, `Chat`, `Response`, `Tool`, `Toolkit`, `McpServer`, developer tools and OTLP APIs only when their owning feature needs them. | Avoid treating a direct-model example as an agent-session contract or a reason to move daemon ownership. |
| Effect website `llms.txt` and `llms-full.txt` | Retrieval was attempted for the root and v4 documentation paths. | Retrieval failed; existence, contents and RC coverage remain unverified. Use the shipped guide/source instead of claiming absence or completeness. |
| `tim-smart/effect-mcp` documentation server | Candidate documentation search/get tooling was found. | Its source indexes external documentation corpora; matching v4 RC coverage is unverified. Inspect the corpus before using it. No confirmed official hosted documentation MCP endpoint was established. |

At the start of SDK implementation, record exact package versions, read their shipped agent resources, verify compiler integration with a small SDK-scoped check, and use current declarations to settle API differences. Keep source attribution separate from test evidence. Copying reference code still requires the licence/provenance process; studying a pattern does not certify it.

### Primary references

- [Effect v4 installation](https://effect.website/docs/v4/getting-started/installation): use the RC channel and check the current runtime/toolchain requirements.
- [Effect package metadata](https://registry.npmjs.org/effect) and [Node platform package metadata](https://registry.npmjs.org/@effect%2fplatform-node): planning baseline `4.0.0-rc.118`, verified 2026-09-30.
- [Official Effect agent guidance](https://github.com/Effect-TS/effect/blob/main/LLMS.md) and [official Effect skills](https://github.com/Effect-TS/skills): check guidance against the installed version before implementation.
- [Effect TypeScript 7 diagnostics](https://github.com/Effect-TS/tsgo) and [Effect language service](https://github.com/Effect-TS/language-service): compiler integration and supported toolchain ranges.
- [Effect v4 LanguageModel](https://effect.website/docs/v4/api/effect/ai/LanguageModel), [Chat](https://effect.website/docs/v4/api/effect/ai/Chat), [Response](https://effect.website/docs/v4/api/effect/ai/Response), [Tool](https://effect.website/docs/v4/api/effect/ai/Tool) and [Toolkit](https://effect.website/docs/v4/api/effect/ai/Toolkit): direct-model APIs and their limits.
- [Effect v4 McpServer](https://effect.website/docs/v4/api/effect/ai/McpServer), [developer tools](https://effect.website/docs/v4/api/effect/devtools/DevTools) and [OTLP tracing](https://effect.website/docs/v4/api/effect/observability/OtlpTracer): optional implementation and inspection tools.
- [Effect documentation MCP candidate](https://github.com/tim-smart/effect-mcp): inspect indexed sources before relying on version coverage.
- [Official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), [Effect Vitest package metadata](https://registry.npmjs.org/@effect%2fvitest) and [Claude Agent SDK package metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk): check exact APIs and peer dependencies before adoption.
- [Codex app-server reference](https://learn.chatgpt.com/docs/app-server): native turn, steering, interruption and session/history operations.
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions): persistent input and native session behavior; installed SDK declarations decide exact available APIs.
- [OMP RPC reference](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/rpc.md): acknowledgement, prompt completion, background settlement and history behavior; compare against the installed version.
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup) and [ACP cancellation](https://agentclientprotocol.com/protocol/v1/cancellation): negotiate capability and lifecycle semantics rather than assume parity.
- [T3 Code](https://github.com/pingdotgg/t3code), [Paseo](https://github.com/getpaseo/paseo), [Orca](https://github.com/stablyai/orca), [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) and [OpenCode](https://github.com/anomalyco/opencode): reference architecture, subject to verified local source and licence provenance.

This document is ready for implementation planning when requested. Publication does not authorize implementation or freeze the contract. The numbered PC acceptance rows refine existing feature IDs; they do not replace the v1 register or erase earlier evidence.
