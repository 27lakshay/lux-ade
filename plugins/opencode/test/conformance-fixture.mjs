// Provider conformance fixture: the OpenCode plugin worker on the deterministic OpenCode server
// (fixtures/mock-opencode.mjs). Run against the packaged artifact:
//   ade-provider-conformance --fixture plugins/opencode/test/conformance-fixture.mjs -- node plugins/opencode/artifact/dist/worker.js
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Checks this worker is known to fail, each with its reason. `pnpm test:conformance` and
 * conformance.test.mjs fail when another check fails or when a recorded gap starts passing.
 */
export const knownGaps = {}

/** @type {import('@ade/provider-sdk/testing').ConformanceFixtureSetup} */
export default async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ade-opencode-conformance-'))
  return {
    // The mock server's scripted prompts: `hold` waits for an interrupt, `approval` asks first.
    prompts: { reply: 'hello', hold: 'hold', request: 'approval' },
    provider: 'plugin:ade.opencode',
    env: {
      ADE_PROVIDER_ID: 'plugin:ade.opencode',
      ADE_OPENCODE_BIN: fileURLToPath(new URL('./fixtures/mock-opencode.mjs', import.meta.url)),
      ADE_MOCK_OPENCODE_DIR: dir,
    },
    nativeSubmissions: async () =>
      (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line && JSON.parse(line).method === 'prompt').length,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
