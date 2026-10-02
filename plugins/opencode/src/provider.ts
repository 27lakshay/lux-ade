// The OpenCode provider as a public SDK factory: its honest descriptor and the
// worker handlers, all served by the OpenCodeSession service.
import type { ProviderWorkerCapability, ProviderWorkerOperation } from '@ade/contracts'
import { DEFAULT_LIMITS, SDK_REQUIREMENTS } from '@ade/provider-sdk'
import type { ProviderFactory, WorkerDescriptor } from '@ade/provider-sdk'
import { Effect } from 'effect'
import { inspectOpenCode } from './native/installation.mjs'
import { OpenCodeSession } from './session.js'
import type { OpenCodeOptions } from './session.js'

const HOST_REFUSES = 'This plugin does not wire it yet, although OpenCode has a native'

/** Operations OpenCode's API offers that this worker does not wire, each with its reason. */
const UNSUPPORTED: Record<string, string> = {
  steer: `${HOST_REFUSES} steering delivery (prompt delivery "steer")`,
  compact: `${HOST_REFUSES} compaction route (POST /api/session/{id}/compact)`,
  rewind: `${HOST_REFUSES} revert route (POST /api/session/{id}/revert/stage)`,
  configure_mcp: 'OpenCode reads MCP servers from its own configuration; the runtime MCP routes are experimental',
}

type Installation = {
  readonly available: boolean
  readonly command?: string
  readonly version?: string | null
  readonly reason?: string
}

/** The descriptor ADE reads at `initialize`. A missing installation makes native work unavailable. */
export function describe(installation: Installation): WorkerDescriptor {
  const reason = installation.available ? '' : (installation.reason ?? 'OpenCode is not installed')
  const native = (method: ProviderWorkerOperation['method'], tier: ProviderWorkerOperation['tier']) =>
    ({
      method,
      tier,
      availability: installation.available ? 'available' : 'unavailable',
      reason,
    }) satisfies ProviderWorkerOperation
  const unsupported = (method: ProviderWorkerOperation['method'], tier: ProviderWorkerOperation['tier']) =>
    ({ method, tier, availability: 'unsupported', reason: UNSUPPORTED[method]! }) satisfies ProviderWorkerOperation
  const capability = (name: ProviderWorkerCapability['name']): ProviderWorkerCapability => ({
    name,
    support: 'supported',
    available: installation.available,
    reason,
  })
  return {
    compatible_protocol_versions: [2],
    name: installation.version ? `OpenCode ${installation.version}` : 'OpenCode',
    capabilities: [
      capability('streaming'),
      capability('images'),
      capability('text_attachments'),
      capability('resume'),
      capability('cancel'),
      capability('tool_approval'),
      capability('questions'),
      capability('child_transcript'),
      {
        name: 'steering',
        support: 'unsupported',
        available: false,
        reason: UNSUPPORTED.steer!,
      },
    ],
    permission_modes: ['default'],
    operations: [
      { method: 'initialize', tier: 'query', availability: 'available', reason: '' },
      native('open', 'effect_command'),
      native('send', 'effect_command'),
      unsupported('steer', 'effect_command'),
      native('cancel', 'idempotent_command'),
      native('answer', 'effect_command'),
      native('history', 'query'),
      native('child_transcript', 'query'),
      unsupported('compact', 'effect_command'),
      unsupported('rewind', 'effect_command'),
      unsupported('configure_mcp', 'idempotent_command'),
    ],
    limits: DEFAULT_LIMITS,
    requirements: SDK_REQUIREMENTS,
  }
}

/** Reads the installation once, then builds the factory the Node runner owns. */
export function openCodeProvider(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ProviderFactory<OpenCodeSession> {
  const installation: Installation = inspectOpenCode(env)
  const options: OpenCodeOptions = {
    command: installation.available ? (installation.command ?? null) : null,
    unavailable: installation.reason,
    cwd,
    env,
  }
  return {
    descriptor: describe(installation),
    dependencies: OpenCodeSession.layer(options),
    acquire: Effect.gen(function* () {
      const session = yield* OpenCodeSession
      return {
        open: session.open,
        send: session.send,
        cancel: session.cancel,
        answer: session.answer,
        history: session.history,
        child_transcript: session.childTranscript,
        events: session.events,
      }
    }),
  }
}
