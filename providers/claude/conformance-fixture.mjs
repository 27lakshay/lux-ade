// Provider conformance fixture: the Claude worker on the deterministic Agent SDK double
// (ADE_E2E_CLAUDE_SDK). Run:
//   ade-provider-conformance --fixture providers/claude/conformance-fixture.mjs -- node providers/claude/worker.mjs
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LIMITS, MAX_OUTPUT_FRAME_BYTES, SDK_REQUIREMENTS } from '@ade/provider-sdk'

const UNSUPPORTED = new Set(['steer', 'compact'])
const tiers = {
  initialize: 'query',
  open: 'effect_command',
  send: 'effect_command',
  steer: 'effect_command',
  cancel: 'idempotent_command',
  answer: 'effect_command',
  history: 'query',
  configure_mcp: 'idempotent_command',
  compact: 'effect_command',
  rewind: 'effect_command',
  child_transcript: 'query',
}
const capabilities = [
  'streaming',
  'images',
  'text_attachments',
  'resume',
  'cancel',
  'questions',
  'child_transcript',
  'tool_approval',
  'steering',
]

/**
 * The descriptor the runtime hands the worker in ADE_CLAUDE_WORKER_DESCRIPTOR, mirrored from
 * `worker_descriptor()` in crates/ade-runtime/src/claude.rs. The worker cannot run without it.
 */
export const descriptor = {
  compatible_protocol_versions: [2],
  name: 'Claude Code',
  capabilities: capabilities.map((name) => ({
    name,
    support: name === 'steering' ? 'unsupported' : 'supported',
    available: name !== 'steering',
    reason: '',
  })),
  permission_modes: ['default', 'plan', 'acceptEdits', 'dontAsk'],
  operations: Object.entries(tiers).map(([method, tier]) => ({
    method,
    tier,
    availability: UNSUPPORTED.has(method) ? 'unsupported' : 'available',
    reason: UNSUPPORTED.has(method) ? 'Claude worker does not implement this operation' : '',
  })),
  limits: { ...DEFAULT_LIMITS, max_output_frame_bytes: MAX_OUTPUT_FRAME_BYTES },
  requirements: SDK_REQUIREMENTS,
}

/**
 * Checks this worker is known to fail, each with its reason. `pnpm test:conformance` and
 * conformance.test.mjs fail when another check fails or when a recorded gap starts passing.
 */
export const knownGaps = {}

/** @type {import('@ade/provider-sdk/testing').ConformanceFixtureSetup} */
export default async function setup() {
  // A private Claude home: the double keeps sessions under it, so a second worker process can
  // resume them, and an inherited CLAUDE_CONFIG_DIR never receives fixture sessions.
  const dir = await mkdtemp(join(tmpdir(), 'ade-claude-conformance-'))
  return {
    // Scripted turns of the SDK double (worker-test-scenarios.mjs).
    prompts: { reply: 'stream', hold: 'hold', request: 'approval' },
    provider: 'claude',
    env: {
      ADE_PROVIDER_ID: 'claude',
      ADE_E2E_CLAUDE_SDK: fileURLToPath(new URL('./worker-test-sdk.mjs', import.meta.url)),
      CLAUDE_CONFIG_DIR: dir,
      ADE_CLAUDE_WORKER_DESCRIPTOR: JSON.stringify(descriptor),
    },
    nativeSubmissions: async () =>
      (await readFile(join(dir, 'ade-mock', 'calls.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line && JSON.parse(line).method === 'send').length,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
