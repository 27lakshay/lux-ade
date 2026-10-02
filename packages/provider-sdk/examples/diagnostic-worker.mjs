import { Effect, Layer } from 'effect'
import { DEFAULT_LIMITS, SDK_REQUIREMENTS } from '@ade/provider-sdk'
import { runProviderWorker } from '@ade/provider-sdk/node'

const diagnosticReason = 'This diagnostic provider inspects protocol compatibility only; it does not run native work.'
const methods = [
  ['initialize', 'query', 'available'],
  ['open', 'effect_command', 'unsupported'],
  ['send', 'effect_command', 'unsupported'],
  ['steer', 'effect_command', 'unsupported'],
  ['cancel', 'idempotent_command', 'unsupported'],
  ['answer', 'effect_command', 'unsupported'],
  ['history', 'query', 'unsupported'],
]
const descriptor = {
  compatible_protocol_versions: [2],
  name: 'ADE diagnostic provider',
  capabilities: [],
  permission_modes: ['default'],
  operations: methods.map(([method, tier, availability]) => ({
    method,
    tier,
    availability,
    reason: availability === 'available' ? '' : diagnosticReason,
  })),
  limits: DEFAULT_LIMITS,
  requirements: SDK_REQUIREMENTS,
}

runProviderWorker({ descriptor, dependencies: Layer.empty, acquire: Effect.succeed({}) })
