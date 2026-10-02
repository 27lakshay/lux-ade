// `@ade/provider-sdk/testing`: provider conformance checks an author runs against their own
// worker without ADE. The harness starts the worker, speaks the worker protocol to it as the
// runtime does, and reports each mandatory behaviour from docs/provider-worker-protocol.md and
// docs/provider-authoring.md as passed, failed or not exercised. It is deterministic evidence
// against the author's fixture peer; it never stands for native, installed or live coverage.
import type {
  Event as ProviderEvent,
  ProviderWorkerCancelResult,
  ProviderWorkerInitialize,
  ProviderWorkerMethod,
  ProviderWorkerSendResult,
  RequestAnswer,
  RequestChoice,
  RequestSchema,
} from '@ade/contracts'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_INPUT_FRAME_BYTES, PROTOCOL_VERSION, SDK_REQUIREMENTS } from './provider.js'
import { WorkerConnection } from './testing-connection.js'
import type { LaunchSpec, ObservedEvent, Reply } from './testing-connection.js'

/** A worker command, as ADE would launch it. `env` is added to the current environment. */
export type CommandTarget = {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
}

/**
 * A module whose export is a `ProviderFactory`, or a function returning one. The harness runs
 * it under the SDK's own `runProviderWorker` in a child Node process, so a worker's framing,
 * limits and shutdown are checked exactly as they ship.
 */
export type FactoryTarget = {
  readonly factoryModule: string
  readonly exportName?: string
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
}

export type ConformanceTarget = CommandTarget | FactoryTarget

/**
 * The author's script for their deterministic native peer. Each prompt is text the peer
 * understands; the harness sends it as a user prompt and observes the worker's protocol output.
 */
export type ConformanceFixture = {
  readonly prompts: {
    /** A turn that runs to completion on its own. Required. */
    readonly reply: string
    /** A turn that keeps running until it is interrupted. Enables the cancellation check. */
    readonly hold?: string
    /** A turn that asks for an approval or question. Enables the answer checks. */
    readonly request?: string
  }
  /** The `provider` sent in `initialize`. Defaults to `conformance`. */
  readonly provider?: string
  /** Overrides the `open` configuration (`model: null`, `permission_mode: 'default'`, no setting sources). */
  readonly config?: Readonly<Record<string, unknown>>
  /** Milliseconds to wait for a reply or a terminal event. Defaults to 15000. */
  readonly timeoutMs?: number
  /**
   * How many prompts the native peer has received in total, read from the peer's own record.
   * With it, a retried send that reaches the peer again fails even when the worker hides it.
   */
  readonly nativeSubmissions?: () => Promise<number>
}

export type CheckId =
  | 'initialize.descriptor'
  | 'initialize.version_negotiation'
  | 'operations.available_handled'
  | 'operations.unavailable_refused'
  | 'open.resume_same_session'
  | 'send.turn_events'
  | 'send.retry_idempotent'
  | 'cancel.evidence'
  | 'answer.unoffered_refused'
  | 'answer.retry_idempotent'
  | 'frames.output_contract'
  | 'frames.input_limits'
  | 'shutdown.pending_replies'

export type CheckStatus = 'pass' | 'fail' | 'not_exercised'

export type CheckResult = {
  readonly id: CheckId
  readonly title: string
  readonly status: CheckStatus
  /** Why it failed, why it was not exercised, or what a pass rests on. */
  readonly details: readonly string[]
}

export type ConformanceReport = {
  readonly worker: string
  readonly name: string | null
  /** Always fixture evidence: the harness cannot observe a real native agent or account. */
  readonly evidence: 'deterministic_fixture'
  readonly disclaimer: string
  readonly passed: boolean
  readonly counts: { readonly pass: number; readonly fail: number; readonly not_exercised: number }
  readonly checks: readonly CheckResult[]
}

export const CONFORMANCE_DISCLAIMER =
  'Deterministic worker-protocol checks against the supplied fixture peer. ' +
  'This is not native, installed or live provider evidence; not-exercised checks are gaps, not passes.'

const TITLES: Record<CheckId, string> = {
  'initialize.descriptor': 'initialize returns a valid descriptor with the required versions',
  'initialize.version_negotiation': 'an initialize offering no compatible version is refused as protocol_mismatch',
  'operations.available_handled': 'every operation declared available has a handler',
  'operations.unavailable_refused': 'every unavailable or unknown operation refuses with a typed failure',
  'open.resume_same_session': 'open starts a session and resuming it returns the same session',
  'send.turn_events': 'send yields contract-valid events in order, with submission identity and one finished',
  'send.retry_idempotent': 'a retried send with the same submission does not run the turn again',
  'cancel.evidence': 'cancel reports evidence as acknowledgement, not proof',
  'answer.unoffered_refused': 'an answer naming a choice the request did not offer is refused',
  'answer.retry_idempotent': 'a retried answer with the same operation ID is not applied twice',
  'frames.output_contract': 'every output frame is contract-valid, correlated and within the declared limits',
  'frames.input_limits': 'malformed and oversized input frames fail explicitly',
  'shutdown.pending_replies': 'shutdown exits within the cleanup deadline and claims no unproven success',
}

const REQUIRED_OPERATIONS: ReadonlyArray<readonly [ProviderWorkerMethod, string]> = [
  ['initialize', 'query'],
  ['open', 'effect_command'],
  ['send', 'effect_command'],
  ['steer', 'effect_command'],
  ['cancel', 'idempotent_command'],
  ['answer', 'effect_command'],
  ['history', 'query'],
]
const OPTIONAL_OPERATIONS: ReadonlyArray<readonly [ProviderWorkerMethod, string]> = [
  ['configure_mcp', 'idempotent_command'],
  ['compact', 'effect_command'],
  ['rewind', 'effect_command'],
  ['child_transcript', 'query'],
]
// The runtime's host bounds (crates/ade-runtime/src/provider_worker.rs).
const HOST_LIMITS: Record<keyof ProviderWorkerInitialize['limits'], number> = {
  max_input_frame_bytes: 16_777_216,
  max_input_entries: 1_024,
  max_initialize_ms: 15_000,
  max_output_frame_bytes: 4_194_304,
  max_history_page_items: 32,
  max_output_entries: 32,
  max_concurrency: 8,
  max_partial_frame_ms: 10_000,
  max_operation_ms: 45_000,
  max_cleanup_ms: 5_000,
}
const LOCAL_NAME = /^[A-Za-z0-9_-]{1,64}$/
// A control character, as Rust's `char::is_control` sees one.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

const MISSING = 'ade-conformance-missing'
const UNOFFERED = 'ade-conformance-unoffered-choice'
const SETTLE_MS = 400
const SUCCESS_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'end_turn'])
const DEFECT_CODES = new Set(['integration_bug', 'internal'])

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Parameters that name nothing the worker knows, valid for each method's contract. */
function probeParams(method: string): unknown {
  switch (method) {
    case 'steer':
      return { session: MISSING, turn: MISSING, message_id: MISSING, text: 'conformance', attachments: [] }
    case 'cancel':
      return { session: MISSING, source_attempt_id: MISSING, submission_id: MISSING }
    case 'answer':
      return { id: MISSING, operation_id: `${MISSING}-answer`, answer: { kind: 'choice', value: UNOFFERED } }
    case 'history':
      return {
        session: MISSING,
        cursor: null,
        snapshot: null,
        max_items: 1,
        max_bytes: 4096,
        context: {
          provider: 'conformance',
          execution_id: MISSING,
          account_id: null,
          lineage: null,
          invalidation_epoch: 0,
        },
      }
    case 'compact':
      return { session: MISSING, operation: `${MISSING}-compact` }
    case 'rewind':
      return { session: MISSING, operation: `${MISSING}-rewind`, turn: null }
    case 'configure_mcp':
      return { servers: {} }
    case 'child_transcript':
      return { session: MISSING, child: MISSING, cursor: null, offset: 0 }
    case 'open':
      return { resume: MISSING, config: { model: null, permission_mode: 'default', setting_sources: [] } }
    case 'send':
      return {
        session: MISSING,
        source_attempt_id: MISSING,
        submission: MISSING,
        message_id: MISSING,
        text: 'conformance',
        attachments: [],
      }
    default:
      return {}
  }
}

const replyText = (reply: Reply): string => {
  switch (reply.kind) {
    case 'result':
      return 'a success result'
    case 'error':
      return reply.failure ? `${reply.failure.code} (${reply.failure.message})` : `untyped error ${reply.code}`
    case 'timeout':
      return 'no reply before the timeout'
    case 'exited':
      return 'no reply: the worker exited'
  }
}

/** A typed refusal that is not a worker defect. */
const typedRefusal = (reply: Reply) =>
  reply.kind === 'error' && reply.failure !== null && !DEFECT_CODES.has(reply.failure.code) && reply.code !== -32601

const launchSpec = (target: ConformanceTarget): LaunchSpec => {
  const env = { ...process.env, ...target.env }
  const cwd = target.cwd ?? process.cwd()
  if ('factoryModule' in target) {
    const host = fileURLToPath(new URL('./conformance-host.js', import.meta.url))
    return {
      command: process.execPath,
      args: [host, resolve(cwd, target.factoryModule), target.exportName ?? 'default'],
      env,
      cwd,
    }
  }
  return { command: target.command, args: target.args ?? [], env, cwd }
}

const describeTarget = (target: ConformanceTarget) =>
  'factoryModule' in target
    ? `factory ${target.factoryModule}${target.exportName ? `#${target.exportName}` : ''}`
    : [target.command, ...(target.args ?? [])].join(' ')

class Checks {
  private readonly results = new Map<CheckId, CheckResult>()
  record(id: CheckId, status: CheckStatus, details: readonly string[]): void {
    this.results.set(id, { id, title: TITLES[id], status, details })
  }
  /** Fails with the problems found, or passes with the notes. */
  conclude(id: CheckId, problems: readonly string[], notes: readonly string[] = []): void {
    this.record(id, problems.length ? 'fail' : 'pass', problems.length ? problems : notes)
  }
  skip(id: CheckId, reason: string): void {
    if (!this.results.has(id)) this.record(id, 'not_exercised', [reason])
  }
  skipRest(reason: string): void {
    for (const id of Object.keys(TITLES) as CheckId[]) this.skip(id, reason)
  }
  list(): CheckResult[] {
    return (Object.keys(TITLES) as CheckId[]).map(
      (id) => this.results.get(id) ?? { id, title: TITLES[id], status: 'not_exercised', details: ['not reached'] },
    )
  }
}

/** Problems with a descriptor, mirroring what the runtime refuses before opening a session. */
export function descriptorProblems(value: unknown): string[] {
  const problems: string[] = []
  if (!isRecord(value)) return ['the initialize result is not an object']
  const descriptor = value as unknown as ProviderWorkerInitialize
  if (descriptor.protocol_version !== PROTOCOL_VERSION)
    problems.push(`protocol_version is ${String(descriptor.protocol_version)}, expected ${PROTOCOL_VERSION}`)
  if (!descriptor.compatible_protocol_versions?.includes(PROTOCOL_VERSION))
    problems.push(`compatible_protocol_versions does not include ${PROTOCOL_VERSION}`)
  for (const [key, expected] of Object.entries(SDK_REQUIREMENTS)) {
    const actual = (descriptor.requirements as unknown as Record<string, unknown> | undefined)?.[key]
    if (actual !== expected)
      problems.push(`requirements.${key} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
  const name = typeof descriptor.name === 'string' ? descriptor.name : ''
  if (!name.trim() || [...name].length > 80 || CONTROL.test(name))
    problems.push('name must be 1 to 80 printable characters')
  for (const [key, max] of Object.entries(HOST_LIMITS)) {
    const declared = (descriptor.limits as unknown as Record<string, unknown> | undefined)?.[key]
    if (typeof declared !== 'number' || declared <= 0 || declared > max)
      problems.push(`limits.${key} is ${String(declared)}; it must be between 1 and ${max}`)
  }
  if ((descriptor.limits?.max_concurrency ?? 0) < 2) problems.push('limits.max_concurrency must be at least 2')
  const seen = new Set<string>()
  for (const operation of descriptor.operations ?? []) {
    if (seen.has(operation.method)) problems.push(`operation ${operation.method} is declared twice`)
    seen.add(operation.method)
    const tier = [...REQUIRED_OPERATIONS, ...OPTIONAL_OPERATIONS].find(([method]) => method === operation.method)?.[1]
    if (tier !== operation.tier)
      problems.push(
        `operation ${operation.method} declares tier ${operation.tier}; the contract tier is ${tier ?? 'none'}`,
      )
    if (operation.method === 'initialize' && operation.availability !== 'available')
      problems.push('initialize must be available')
    if (operation.availability !== 'available' && !operation.reason.trim())
      problems.push(`unavailable operation ${operation.method} gives no reason a person can act on`)
    if (operation.reason.length > 512 || CONTROL.test(operation.reason))
      problems.push(`operation ${operation.method} has an over-long or unprintable reason`)
  }
  for (const [method] of REQUIRED_OPERATIONS)
    if (!seen.has(method)) problems.push(`required operation ${method} is not declared`)
  const capabilities = new Set<string>()
  for (const capability of descriptor.capabilities ?? []) {
    if (capabilities.has(capability.name)) problems.push(`capability ${capability.name} is declared twice`)
    capabilities.add(capability.name)
  }
  const modes = descriptor.permission_modes ?? []
  if (modes[0] !== 'default') problems.push('permission_modes must start with default')
  if (modes.length > 16 || new Set(modes).size !== modes.length || !modes.every((mode) => LOCAL_NAME.test(mode)))
    problems.push('permission_modes must be at most 16 distinct local names')
  return problems
}

type TurnKey = { readonly submission: string; readonly turn: string | null }
const belongs = (event: ProviderEvent, key: TurnKey) => {
  const submission = (event as { submission?: string | null }).submission
  if (submission === key.submission) return true
  const turn = (event as { turn?: string | null }).turn
  return (submission === undefined || submission === null) && key.turn !== null && turn === key.turn
}
const isFinished = (key: TurnKey) => (event: ProviderEvent) => event.type === 'finished' && belongs(event, key)

/** Runs every conformance check against one worker and returns the report. */
export async function runConformance(options: {
  readonly target: ConformanceTarget
  readonly fixture: ConformanceFixture
}): Promise<ConformanceReport> {
  const { target, fixture } = options
  const launch = launchSpec(target)
  const timeout = fixture.timeoutMs ?? 15_000
  const checks = new Checks()
  const connections: WorkerConnection[] = []
  const connect = (label: string): WorkerConnection => {
    const connection = new WorkerConnection(label, launch)
    connections.push(connection)
    return connection
  }
  const config = { model: null, permission_mode: 'default', setting_sources: [], ...fixture.config }
  const initializeParams = (versions: number[]) => ({ versions, provider: fixture.provider ?? 'conformance' })
  let descriptor: ProviderWorkerInitialize | undefined
  let session: string | undefined
  const sent = new Set<string>()
  let cleanupMs = HOST_LIMITS.max_cleanup_ms

  const main: WorkerConnection = connect('worker')
  try {
    // 1. Handshake and descriptor.
    const initialized = await main.request('initialize', initializeParams([PROTOCOL_VERSION]), timeout)
    if (initialized.kind !== 'result') {
      checks.record('initialize.descriptor', 'fail', [
        `initialize returned ${replyText(initialized)}`,
        ...(main.stderr() ? [`stderr: ${main.stderr()}`] : []),
      ])
      checks.skipRest('initialize did not return a descriptor')
      return finish()
    }
    const problems = descriptorProblems(initialized.result)
    descriptor = initialized.result as ProviderWorkerInitialize
    checks.conclude(
      'initialize.descriptor',
      [...problems, ...main.violations.filter((v) => v.includes('initialize'))],
      [`${descriptor.name}: protocol ${descriptor.protocol_version}, SDK ${descriptor.requirements?.sdk_version}`],
    )
    if (descriptor.limits?.max_output_frame_bytes) main.limitOutput(descriptor.limits.max_output_frame_bytes)
    if (descriptor.limits?.max_cleanup_ms) cleanupMs = descriptor.limits.max_cleanup_ms
    const operation = (method: string) => descriptor?.operations?.find((entry) => entry.method === method)
    const available = (method: string) => operation(method)?.availability === 'available'

    // 2. Declared operations: available ones are handled, the rest refuse with a typed failure.
    const handled: string[] = []
    const refused: string[] = []
    const handledProblems: string[] = []
    const refusedProblems: string[] = []
    const methods = [...REQUIRED_OPERATIONS, ...OPTIONAL_OPERATIONS].map(([method]) => method)
    for (const method of methods.filter((name) => name !== 'initialize')) {
      // Open and send are exercised with real prompts below; probing them would start native work.
      if (available(method) && (method === 'open' || method === 'send')) continue
      const reply = await main.request(method, probeParams(method), timeout)
      if (available(method)) {
        if (reply.kind === 'error' && (reply.code === -32601 || reply.failure?.code === 'integration_bug'))
          handledProblems.push(`${method} is declared available but has no working handler: ${replyText(reply)}`)
        else if (reply.kind === 'timeout' || reply.kind === 'exited')
          handledProblems.push(`${method} probe got ${replyText(reply)}`)
        else if (reply.kind === 'error' && reply.failure === null)
          handledProblems.push(`${method} probe was refused without a typed failure`)
        else handled.push(`${method}: ${replyText(reply)}`)
      } else if (typedRefusal(reply) || (reply.kind === 'error' && reply.failure?.code === 'unsupported'))
        refused.push(`${method}: ${replyText(reply)}`)
      else
        refusedProblems.push(
          `${method} is declared ${operation(method)?.availability ?? 'absent'} but got ${replyText(reply)}`,
        )
    }
    const unknown = await main.request('ade_conformance_unknown', {}, timeout)
    if (unknown.kind === 'error' && unknown.failure !== null) refused.push(`unknown method: ${replyText(unknown)}`)
    else refusedProblems.push(`an unknown method got ${replyText(unknown)}`)
    for (const method of ['open', 'send'])
      if (available(method)) handled.push(`${method}: exercised with fixture prompts`)
    checks.conclude('operations.available_handled', handledProblems, handled)
    checks.conclude('operations.unavailable_refused', refusedProblems, refused)

    // 3. Open a session.
    if (!available('open')) {
      checks.skipRest('open is not declared available, so no session could be opened')
    } else {
      const opened = await main.request('open', { resume: null, config }, timeout)
      if (opened.kind !== 'result' || !isRecord(opened.result) || typeof opened.result.session !== 'string') {
        checks.record('open.resume_same_session', 'fail', [`open returned ${replyText(opened)}`])
        checks.skipRest('open did not return a session')
      } else {
        session = opened.result.session
        const history = Array.isArray(opened.result.history) ? opened.result.history : []
        if (history.length > (descriptor.limits?.max_history_page_items ?? HOST_LIMITS.max_history_page_items))
          main.violations.push(`worker: open returned ${history.length} history items, above max_history_page_items`)
        await exerciseSession(main, session)
      }
    }
    await exerciseShutdown(main)
    if (session !== undefined) await exerciseResume(session)
    else checks.skip('open.resume_same_session', 'no session was opened')
    await exerciseFraming()
    return finish()
  } finally {
    await Promise.all(connections.filter((connection) => !connection.exit).map((connection) => connection.stop(1000)))
  }

  function finish(): ConformanceReport {
    const violations = connections.flatMap((connection) => connection.violations)
    const unreached = connections.every((connection) => connection.frameCount === 0)
    if (unreached) checks.skip('frames.output_contract', 'the worker wrote no frames')
    else
      checks.conclude('frames.output_contract', violations, [
        `${connections.reduce((n, c) => n + c.frameCount, 0)} frames checked`,
      ])
    const list = checks.list()
    const counts = {
      pass: list.filter((check) => check.status === 'pass').length,
      fail: list.filter((check) => check.status === 'fail').length,
      not_exercised: list.filter((check) => check.status === 'not_exercised').length,
    }
    return {
      worker: describeTarget(target),
      name: descriptor?.name ?? null,
      evidence: 'deterministic_fixture',
      disclaimer: CONFORMANCE_DISCLAIMER,
      passed: counts.fail === 0,
      counts,
      checks: list,
    }
  }

  async function sendPrompt(connection: WorkerConnection, opened: string, submission: string, text: string) {
    sent.add(submission)
    const params = {
      session: opened,
      source_attempt_id: 'ade-conformance-attempt',
      submission,
      message_id: `${submission}-message`,
      text,
      attachments: [],
    }
    const from = connection.frameCount
    const reply = await connection.request('send', params, timeout)
    const turn = reply.kind === 'result' ? (reply.result as ProviderWorkerSendResult).turn : null
    return { params, reply, from, key: { submission, turn } satisfies TurnKey }
  }

  async function exerciseSession(connection: WorkerConnection, opened: string): Promise<void> {
    let firstSend: Awaited<ReturnType<typeof sendPrompt>> | undefined
    const available = (method: string) =>
      descriptor?.operations?.find((entry) => entry.method === method)?.availability === 'available'
    if (!available('send')) {
      checks.skip('send.turn_events', 'send is not declared available')
      checks.skip('send.retry_idempotent', 'send is not declared available')
    } else {
      // A turn that completes: ordered events naming the submission, exactly one finished.
      const first = await sendPrompt(connection, opened, 'conformance-reply', fixture.prompts.reply)
      if (first.reply.kind !== 'result') {
        checks.record('send.turn_events', 'fail', [`send returned ${replyText(first.reply)}`])
        checks.skip('send.retry_idempotent', 'the first send was not accepted')
      } else {
        const finished = await connection.waitForEvent(isFinished(first.key), timeout, first.from)
        await sleep(SETTLE_MS)
        const events = connection.events.filter((entry) => entry.seq > first.from)
        checks.conclude('send.turn_events', turnProblems(events, first.key, opened, finished), [
          `${events.filter((entry) => belongs(entry.event, first.key)).length} events for the turn, ending ${finished?.event.type === 'finished' ? finished.event.status : ''}`,
        ])
        firstSend = first
      }
    }
    await exerciseCancel(connection, opened, available('send') && available('cancel'))
    await exerciseAnswer(connection, opened, available('send') && available('answer'))
    // Last, so that a retry which leaves the worker in a bad state cannot mask the checks above.
    if (firstSend) await exerciseRetry(connection, firstSend)
  }

  async function exerciseRetry(
    connection: WorkerConnection,
    first: Awaited<ReturnType<typeof sendPrompt>>,
  ): Promise<void> {
    // The same send again: the same submission and message must not run a second turn.
    const nativeBefore = await fixture.nativeSubmissions?.()
    const retryFrom = connection.frameCount
    const retry = await connection.request('send', first.params, timeout)
    const again = await connection.waitForEvent(
      (event) => (event.type === 'started' || event.type === 'finished') && belongs(event, first.key),
      Math.min(timeout, 2_000),
      retryFrom,
    )
    const nativeAfter = await fixture.nativeSubmissions?.()
    const problems: string[] = []
    if (retry.kind === 'timeout' || retry.kind === 'exited') problems.push(`the retried send got ${replyText(retry)}`)
    if (retry.kind === 'error' && !typedRefusal(retry))
      problems.push(`the retried send failed as a defect: ${replyText(retry)}`)
    if (again) problems.push(`the retried send ran the turn again (a new ${again.event.type} event)`)
    if (nativeBefore !== undefined && nativeAfter !== undefined && nativeAfter > nativeBefore)
      problems.push(`the native peer received ${nativeAfter - nativeBefore} more prompt(s) for the retry`)
    checks.conclude('send.retry_idempotent', problems, [
      `retry got ${replyText(retry)}`,
      nativeBefore === undefined
        ? 'no native submission counter supplied: only protocol-visible repetition was checked'
        : 'the native peer received no second prompt',
    ])
  }

  async function exerciseCancel(connection: WorkerConnection, opened: string, enabled: boolean): Promise<void> {
    if (!enabled) return checks.skip('cancel.evidence', 'send or cancel is not declared available')
    if (fixture.prompts.hold === undefined)
      return checks.skip(
        'cancel.evidence',
        'the fixture supplies no hold prompt, so no running turn could be cancelled',
      )
    const held = await sendPrompt(connection, opened, 'conformance-hold', fixture.prompts.hold)
    if (held.reply.kind !== 'result')
      return checks.record('cancel.evidence', 'fail', [`the hold prompt's send returned ${replyText(held.reply)}`])
    await connection.waitForEvent((event) => belongs(event, held.key), Math.min(timeout, 5_000), held.from)
    const problems: string[] = []
    const notes: string[] = []
    const started = Date.now()
    const cancel = { session: opened, source_attempt_id: 'ade-conformance-attempt', submission_id: held.key.submission }
    const reply = await connection.request('cancel', cancel, timeout)
    const elapsed = Date.now() - started
    if (reply.kind !== 'result') problems.push(`cancel returned ${replyText(reply)}`)
    else {
      const evidence = (reply.result as ProviderWorkerCancelResult).evidence
      if (evidence.termination === 'confirmed' && !evidence.interruption_requested)
        problems.push('termination is confirmed although no interruption was requested')
      if (
        evidence.queued_work_count !== null &&
        (!Number.isSafeInteger(evidence.queued_work_count) || evidence.queued_work_count < 0)
      )
        problems.push(`queued_work_count is ${evidence.queued_work_count}`)
      notes.push(
        `evidence: scope ${evidence.scope}, interruption ${evidence.interruption_requested ? 'requested' : 'not requested'}, termination ${evidence.termination}`,
      )
      if (elapsed > 5_000) notes.push(`the reply took ${elapsed} ms; ADE reports a cancel pending after 5000 ms`)
      // The SDK writes events and replies on separate lanes, so the terminal event may follow the
      // reply; confirmed termination still requires that the worker reports one for this turn.
      const finished = await connection.waitForEvent(isFinished(held.key), timeout, held.from)
      if (evidence.termination === 'confirmed' && !finished)
        problems.push('termination is confirmed but the worker reported no terminal event for the turn')
      await sleep(SETTLE_MS)
      const count = connection.events.filter(
        (entry) => entry.seq > held.from && isFinished(held.key)(entry.event),
      ).length
      if (count > 1) problems.push(`the cancelled turn finished ${count} times`)
      if (!finished) notes.push('no native terminal event arrived: ADE would leave the Stop unresolved')
      else if (finished.event.type === 'finished')
        notes.push(
          `terminal event: ${finished.event.status}, interrupt_requested ${String(finished.event.interrupt_requested)}`,
        )
      // Cancel is an idempotent command: repeating it after the turn ended is answered, not a defect.
      const repeated = await connection.request('cancel', cancel, timeout)
      if (
        repeated.kind === 'timeout' ||
        repeated.kind === 'exited' ||
        (repeated.kind === 'error' && !typedRefusal(repeated))
      )
        problems.push(`a repeated cancel got ${replyText(repeated)}`)
      else notes.push(`a repeated cancel got ${replyText(repeated)}`)
    }
    checks.conclude('cancel.evidence', problems, notes)
  }

  async function exerciseAnswer(connection: WorkerConnection, opened: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      checks.skip('answer.unoffered_refused', 'send or answer is not declared available')
      return checks.skip('answer.retry_idempotent', 'send or answer is not declared available')
    }
    if (fixture.prompts.request === undefined) {
      checks.skip('answer.unoffered_refused', 'the fixture supplies no request prompt')
      return checks.skip('answer.retry_idempotent', 'the fixture supplies no request prompt')
    }
    const asked = await sendPrompt(connection, opened, 'conformance-request', fixture.prompts.request)
    if (asked.reply.kind !== 'result') {
      checks.record('answer.unoffered_refused', 'fail', [
        `the request prompt's send returned ${replyText(asked.reply)}`,
      ])
      return checks.skip('answer.retry_idempotent', 'the request prompt was not accepted')
    }
    const request = await connection.waitForEvent(
      (event) => event.type === 'request' && belongs(event, asked.key),
      timeout,
      asked.from,
    )
    if (!request || request.event.type !== 'request') {
      checks.record('answer.unoffered_refused', 'fail', [
        'the request prompt produced no request event for its submission',
      ])
      return checks.skip('answer.retry_idempotent', 'no request event arrived')
    }
    const schema = request.event.metadata?.schema
    const answers = schema ? answersFor(schema) : undefined
    if (!answers) {
      const reason = `the request's schema (${schema?.kind ?? 'none'}) offers no choice or question the harness can answer`
      checks.skip('answer.unoffered_refused', reason)
      checks.skip('answer.retry_idempotent', reason)
      await connection.request(
        'cancel',
        { session: opened, source_attempt_id: 'ade-conformance-attempt', submission_id: asked.key.submission },
        timeout,
      )
      return
    }
    const id = request.event.id
    const unoffered = await connection.request(
      'answer',
      { id, operation_id: 'conformance-answer-unoffered', answer: answers.unoffered },
      timeout,
    )
    const problems: string[] = []
    if (unoffered.kind === 'result') problems.push('an answer the request did not offer was accepted')
    else if (!typedRefusal(unoffered)) problems.push(`an unoffered answer got ${replyText(unoffered)}`)
    const answer = { id, operation_id: 'conformance-answer', answer: answers.offered }
    const accepted = await connection.request('answer', answer, timeout)
    if (accepted.kind !== 'result')
      problems.push(`an offered answer was refused after the unoffered one: ${replyText(accepted)}`)
    checks.conclude('answer.unoffered_refused', problems, [`unoffered answer: ${replyText(unoffered)}`])
    if (accepted.kind !== 'result') {
      checks.skip('answer.retry_idempotent', 'the offered answer was not accepted')
    } else {
      const retried = await connection.request('answer', answer, timeout)
      await connection.waitForEvent(isFinished(asked.key), timeout, asked.from)
      await sleep(SETTLE_MS)
      // Events and replies travel on separate lanes, so count every resolution of the request.
      const resolutions = connection.events.filter(
        (entry) => entry.seq > asked.from && entry.event.type === 'resolved' && entry.event.id === id,
      ).length
      const retryProblems: string[] = []
      if (
        retried.kind === 'timeout' ||
        retried.kind === 'exited' ||
        (retried.kind === 'error' && !typedRefusal(retried))
      )
        retryProblems.push(`the retried answer got ${replyText(retried)}`)
      if (resolutions > 1) retryProblems.push('the retried answer resolved the request a second time')
      const finishedCount = connection.events.filter(
        (entry) => entry.seq > asked.from && isFinished(asked.key)(entry.event),
      ).length
      if (finishedCount > 1) retryProblems.push(`the answered turn finished ${finishedCount} times`)
      checks.conclude('answer.retry_idempotent', retryProblems, [`retried answer got ${replyText(retried)}`])
    }
    await connection.waitForEvent(isFinished(asked.key), timeout, asked.from)
  }

  async function exerciseShutdown(connection: WorkerConnection): Promise<void> {
    const problems: string[] = []
    const notes: string[] = []
    const prompt = fixture.prompts.hold ?? fixture.prompts.reply
    const canSend =
      session !== undefined &&
      descriptor?.operations?.some((entry) => entry.method === 'send' && entry.availability === 'available')
    let inflight: { reply: Promise<Reply>; from: number; key: TurnKey } | undefined
    if (canSend && session !== undefined) {
      const submission = 'conformance-shutdown'
      sent.add(submission)
      const from = connection.frameCount
      const { reply } = connection.start(
        'send',
        {
          session,
          source_attempt_id: 'ade-conformance-attempt',
          submission,
          message_id: `${submission}-message`,
          text: prompt,
          attachments: [],
        },
        cleanupMs + 2_000,
      )
      inflight = { reply, from, key: { submission, turn: null } }
    }
    connection.closeInput()
    const exit = await connection.waitForExit(cleanupMs + 1_000)
    if (!exit)
      problems.push(
        `the worker was still running ${cleanupMs + 1_000} ms after stdin closed (max_cleanup_ms ${cleanupMs})`,
      )
    else if (exit.code !== 0)
      problems.push(`the worker exited with ${exit.signal ?? `code ${exit.code}`} after an orderly shutdown`)
    else notes.push('exited with code 0 within the cleanup deadline')
    if (inflight) {
      const reply = await inflight.reply
      const key = inflight.key
      const events = connection.events.filter((entry) => entry.seq > inflight.from && belongs(entry.event, key))
      if (reply.kind === 'result') {
        const result = reply.result as ProviderWorkerSendResult
        const evidence = events.some(
          (entry) =>
            entry.seq < reply.seq && entry.event.type === 'submitted' && entry.event.native_outcome === 'accepted',
        )
        if (result.native_outcome === 'accepted' && !evidence)
          problems.push('the in-flight send was answered accepted without native acceptance evidence')
        notes.push(`the in-flight send was answered ${result.native_outcome}`)
      } else notes.push(`the in-flight send got ${replyText(reply)}`)
      if (fixture.prompts.hold !== undefined) {
        const settled = events.find(
          (entry) => entry.event.type === 'finished' && SUCCESS_STATUSES.has(entry.event.status) && !entry.event.error,
        )
        if (settled) problems.push('shutdown reported the held prompt as finished successfully')
      }
    } else notes.push('no session was open, so only the exit was checked')
    if (!exit) await connection.stop(0)
    checks.conclude('shutdown.pending_replies', problems, notes)
  }

  async function exerciseResume(opened: string): Promise<void> {
    const resumed: WorkerConnection = connect('resumed worker')
    try {
      const initialized = await resumed.request('initialize', initializeParams([PROTOCOL_VERSION]), timeout)
      if (initialized.kind !== 'result')
        return checks.record('open.resume_same_session', 'fail', [
          `a second worker's initialize returned ${replyText(initialized)}`,
        ])
      const reply = await resumed.request('open', { resume: opened, config }, timeout)
      if (reply.kind !== 'result')
        return checks.record('open.resume_same_session', 'fail', [`resuming ${opened} returned ${replyText(reply)}`])
      const again = (reply.result as { session?: unknown }).session
      checks.conclude(
        'open.resume_same_session',
        again === opened ? [] : [`resuming ${opened} returned session ${JSON.stringify(again)}`],
        [`a new worker process resumed ${opened}`],
      )
    } finally {
      await resumed.stop(cleanupMs + 1_000)
    }
  }

  async function exerciseFraming(): Promise<void> {
    const probe: WorkerConnection = connect('framing worker')
    try {
      // No compatible version: a typed protocol_mismatch, not a descriptor.
      const mismatch = await probe.request('initialize', initializeParams([PROTOCOL_VERSION - 1]), timeout)
      checks.conclude(
        'initialize.version_negotiation',
        mismatch.kind === 'error' && mismatch.failure?.code === 'protocol_mismatch'
          ? []
          : [`initialize offering only version ${PROTOCOL_VERSION - 1} got ${replyText(mismatch)}`],
        ['refused as protocol_mismatch'],
      )
      const problems: string[] = []
      const notes: string[] = []
      // A malformed frame: an uncorrelated refusal or an explicit exit, never silence.
      const before = probe.uncorrelatedRefusals()
      probe.write('{"jsonrpc":"2.0","id":\n')
      const deadline = Date.now() + 3_000
      while (probe.uncorrelatedRefusals() === before && !probe.exitStatus() && Date.now() < deadline)
        await probe.nextChange(deadline - Date.now())
      if (probe.uncorrelatedRefusals() > before) notes.push('a malformed frame got an uncorrelated refusal')
      else if (ended(probe) && ended(probe)?.code !== 0)
        notes.push(`a malformed frame ended the worker (${exitText(probe)})`)
      else problems.push('a malformed frame was silently ignored')
      // A frame above the declared input limit: refused or the transport ends, never a result.
      if (!probe.exitStatus()) {
        const limit = Math.min(
          MAX_INPUT_FRAME_BYTES,
          descriptor?.limits?.max_input_frame_bytes ?? MAX_INPUT_FRAME_BYTES,
        )
        const head =
          '{"jsonrpc":"2.0","id":"ade-conformance-oversized","method":"configure_mcp","params":{"servers":{},"padding":"'
        const tail = '"}}\n'
        const padding = Math.max(0, limit + 1 - head.length - tail.length + 1)
        const refusalsBefore = probe.uncorrelatedRefusals()
        const id = 'ade-conformance-oversized'
        probe.writeRaw(id, Buffer.from(head + 'x'.repeat(padding) + tail))
        const until = Date.now() + 5_000 + (descriptor?.limits?.max_partial_frame_ms ?? 0)
        const answered = () => probe.rawReplies.find((reply) => reply.id === id)
        while (
          probe.uncorrelatedRefusals() === refusalsBefore &&
          !answered() &&
          !probe.exitStatus() &&
          Date.now() < until
        )
          await probe.nextChange(until - Date.now())
        const reply = answered()
        if (reply && !reply.refused)
          problems.push(`a ${limit + 1}-byte frame above max_input_frame_bytes was processed instead of refused`)
        else if (reply || probe.uncorrelatedRefusals() > refusalsBefore)
          notes.push(`a ${limit + 1}-byte frame was refused`)
        else if (ended(probe)) notes.push(`a ${limit + 1}-byte frame ended the worker (${exitText(probe)})`)
        else problems.push(`a ${limit + 1}-byte frame above max_input_frame_bytes got no refusal and no exit`)
      }
      checks.conclude('frames.input_limits', problems, notes)
    } finally {
      await probe.stop(cleanupMs + 1_000)
    }
  }

  function turnProblems(
    events: readonly ObservedEvent[],
    key: TurnKey,
    opened: string,
    finished: ObservedEvent | undefined,
  ): string[] {
    const problems: string[] = []
    if (!finished) problems.push(`no finished event for submission ${key.submission} within ${timeout} ms`)
    const turn = events.filter((entry) => belongs(entry.event, key))
    if (!turn.some((entry) => (entry.event as { submission?: string | null }).submission === key.submission))
      problems.push(`no event names submission ${key.submission}`)
    const finishes = turn.filter((entry) => entry.event.type === 'finished')
    if (finishes.length > 1) problems.push(`the turn finished ${finishes.length} times`)
    const end = finishes[0]?.seq
    if (end !== undefined) {
      const late = turn.filter(
        (entry) => entry.seq > end && ['started', 'delta', 'item', 'request', 'submitted'].includes(entry.event.type),
      )
      if (late.length)
        problems.push(`${late.map((entry) => entry.event.type).join(', ')} arrived after the turn finished`)
    }
    const startedAt = turn.find((entry) => entry.event.type === 'started')?.seq
    const outputBefore = turn.find(
      (entry) => ['delta', 'item'].includes(entry.event.type) && startedAt !== undefined && entry.seq < startedAt,
    )
    if (outputBefore) problems.push(`${outputBefore.event.type} arrived before the turn started`)
    for (const entry of events) {
      const named = (entry.event as { session?: unknown }).session
      if (typeof named === 'string' && named !== opened)
        problems.push(`a ${entry.event.type} event names session ${named}, not ${opened}`)
      const submission = (entry.event as { submission?: unknown }).submission
      if (typeof submission === 'string' && !sent.has(submission))
        problems.push(`a ${entry.event.type} event names submission ${submission}, which was never sent`)
    }
    return [...new Set(problems)]
  }
}

const ended = (connection: WorkerConnection) => connection.exitStatus()
const exitText = (connection: WorkerConnection) => {
  const exit = connection.exitStatus()
  return exit ? (exit.signal ?? `code ${exit.code}`) : 'running'
}

/** An answer the request offered (preferring a refusal) and one it did not. */
function answersFor(schema: RequestSchema): { offered: RequestAnswer; unoffered: RequestAnswer } | undefined {
  if (schema.kind === 'choices' && schema.choices.length > 0) {
    const refusing = (choice: RequestChoice) =>
      /reject|deny|decline|cancel|no\b/i.test(`${choice.label} ${String(choice.value)}`)
    const choice = schema.choices.find(refusing) ?? schema.choices[0]!
    return { offered: { kind: 'choice', value: choice.value }, unoffered: { kind: 'choice', value: UNOFFERED } }
  }
  if (schema.kind === 'questions' && schema.questions.length > 0) {
    const answers: Record<string, unknown[]> = {}
    for (const question of schema.questions) answers[question.id] = [question.options?.[0]?.value ?? 'conformance']
    return {
      offered: { kind: 'questions', answers },
      unoffered: { kind: 'questions', answers: { ...answers, [UNOFFERED]: ['conformance'] } },
    }
  }
  return undefined
}

/** A plain-text report, one line per check with its reasons beneath. */
export function formatReport(report: ConformanceReport): string {
  const label = { pass: 'PASS', fail: 'FAIL', not_exercised: 'SKIP' } as const
  const lines = [
    `ADE provider conformance: ${report.name ?? 'unnamed worker'}`,
    `Worker: ${report.worker}`,
    report.disclaimer,
    '',
  ]
  for (const check of report.checks) {
    lines.push(`${label[check.status]}  ${check.id}  ${check.title}`)
    for (const detail of check.details)
      lines.push(`      ${check.status === 'not_exercised' ? 'not exercised: ' : ''}${detail}`)
  }
  lines.push(
    '',
    `${report.counts.pass} passed, ${report.counts.fail} failed, ${report.counts.not_exercised} not exercised: ${report.passed ? 'CONFORMS on the exercised checks' : 'DOES NOT CONFORM'}`,
  )
  return lines.join('\n')
}

/** What a fixture module may export: a fixture, or a setup that stages the native peer first. */
export type ConformanceFixtureSetup = (context: { readonly cwd: string }) => Promise<
  ConformanceFixture & {
    readonly env?: Readonly<Record<string, string>>
    readonly cleanup?: () => Promise<void>
  }
>
