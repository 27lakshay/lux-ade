// `pnpm test:conformance`: run the provider conformance CLI, as a provider author would, against
// the Claude worker (SDK double), the ACP worker (fixture agent) and the packaged OpenCode plugin
// (mock server). Each fixture names its recorded gaps; the run fails when a check fails that is
// not recorded, or when a recorded gap starts passing and its record must be removed.
// Requires `pnpm build:sdk`. `--provider <name>` narrows the run.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = resolve(root, 'packages/provider-sdk/dist/conformance-cli.js')
export const conformanceWorkers = {
  claude: { fixture: 'providers/claude/conformance-fixture.mjs', worker: 'providers/claude/worker.mjs' },
  acp: { fixture: 'providers/acp/conformance-fixture.mjs', worker: 'providers/acp/worker.mjs' },
  opencode: {
    fixture: 'plugins/opencode/test/conformance-fixture.mjs',
    worker: 'plugins/opencode/artifact/dist/worker.js',
  },
}

/** Compares a report's failing checks with the fixture's recorded gaps. */
export function compareGaps(report, knownGaps = {}) {
  const failing = report.checks.filter((check) => check.status === 'fail').map((check) => check.id)
  return {
    unexpected: failing.filter((id) => !(id in knownGaps)),
    fixed: Object.keys(knownGaps).filter((id) => !failing.includes(id)),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let names = Object.keys(conformanceWorkers)
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--provider' || !(args[1] in conformanceWorkers))
      throw new Error(`Use --provider ${names.join(', ')}`)
    names = [args[1]]
  }
  let failed = false
  for (const name of names) {
    const { fixture, worker } = conformanceWorkers[name]
    const { knownGaps } = await import(pathToFileURL(resolve(root, fixture)).href)
    const run = spawnSync(process.execPath, [cli, '--fixture', fixture, '--json', '--', process.execPath, worker], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    if (run.status === 2 || !run.stdout) {
      console.error(`${name}: the conformance CLI could not run\n${run.stderr}`)
      failed = true
      continue
    }
    const report = JSON.parse(run.stdout)
    const { formatReport } = await import(pathToFileURL(resolve(root, 'packages/provider-sdk/dist/testing.js')).href)
    console.log(`\n=== ${name} ===\n${formatReport(report)}`)
    const { unexpected, fixed } = compareGaps(report, knownGaps)
    for (const [id, reason] of Object.entries(knownGaps ?? {}))
      if (!fixed.includes(id)) console.log(`Recorded gap ${id}: ${reason}`)
    if (unexpected.length) console.error(`${name}: unrecorded failures: ${unexpected.join(', ')}`)
    if (fixed.length) console.error(`${name}: recorded gaps now pass; remove them from ${fixture}: ${fixed.join(', ')}`)
    if (unexpected.length || fixed.length) failed = true
  }
  process.exitCode = failed ? 1 : 0
}
