// Provider conformance fixture: the ACP worker on a private copy of the deterministic fixture
// agent. Run: ade-provider-conformance --fixture providers/acp/conformance-fixture.mjs -- node providers/acp/worker.mjs
import { rm } from 'node:fs/promises'
import { agentCalls, stageFixture } from './worker-peer.mjs'

/**
 * Checks this worker is known to fail, each with its reason. `pnpm test:conformance` and
 * conformance.test.mjs fail when another check fails or when a recorded gap starts passing.
 */
export const knownGaps = {}

/** @type {import('@ade/provider-sdk/testing').ConformanceFixtureSetup} */
export default async function setup() {
  const fixture = await stageFixture()
  return {
    // The fixture agent's scripted prompts (e2e/protocol/fixtures/adapters/acp_agent.mjs).
    prompts: { reply: 'hello', hold: 'hold', request: 'permission please' },
    provider: 'adapter:fixture',
    env: {
      ADE_PROVIDER_ID: 'adapter:fixture',
      ADE_ACP_AGENT: JSON.stringify({
        name: 'Fixture ACP',
        command: fixture.command,
        args: [],
        env: { ACP_FIXTURE_DIR: fixture.dir },
      }),
    },
    nativeSubmissions: async () =>
      (await agentCalls(fixture.dir)).filter((call) => call.method === 'session/prompt').length,
    cleanup: () => rm(fixture.dir, { recursive: true, force: true }),
  }
}
