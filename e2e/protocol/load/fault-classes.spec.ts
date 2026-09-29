// F140: the fault conformance suite covers every fault class of architecture
// section 12. `fault-suite.ts` maps each fault of each class to the tests
// that inject it. This spec lists what `pnpm test:e2e:protocol:faults`
// actually runs and checks that every mapped test is in it, so a renamed or
// deleted test cannot silently drop a fault from the suite. A fault no
// protocol E2E test can inject yet is reported as a fixme naming the gap.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '../fixtures'
import { repositoryRoot } from '../fixtures/environment'
import { faultClasses } from '../fault-suite'

type Listed = { file: string; title: string; fixme: boolean }
type JsonSuite = {
  title: string
  file?: string
  specs?: Array<{ title: string; file: string; tests?: Array<{ annotations?: Array<{ type: string }> }> }>
  suites?: JsonSuite[]
}

/** Every test the fault suite runs, as its file under e2e/protocol and its full title. */
async function faultSuiteTests(config = 'playwright.faults.config.ts'): Promise<Listed[]> {
  const { stdout } = await promisify(execFile)(
    join(repositoryRoot, 'node_modules/.bin/playwright'),
    ['test', '--config', config, '--list', '--reporter=json'],
    { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0' } },
  )
  const report = JSON.parse(stdout) as { suites: JsonSuite[] }
  const listed: Listed[] = []
  const walk = (suite: JsonSuite, path: string[]) => {
    for (const spec of suite.specs ?? []) {
      const fixme = (spec.tests ?? []).some((entry) => (entry.annotations ?? []).some((note) => note.type === 'fixme'))
      listed.push({ file: spec.file, title: [...path, spec.title].join(' › '), fixme })
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title])
  }
  for (const root of report.suites) walk(root, [])
  return listed
}

test('every fault class of architecture section 12 has tests that run in the fault suite', async () => {
  const listed = await faultSuiteTests()
  const system = await faultSuiteTests('playwright.system.config.ts')
  expect(listed.length).toBeGreaterThan(200)
  for (const entry of faultClasses) {
    for (const fault of entry.faults) {
      if (!fault.gap)
        expect.soft(fault.tests.length, `class ${entry.id}: ${fault.fault} names no test`).toBeGreaterThan(0)
      for (const named of fault.tests) {
        const found = (named.suite === 'system' ? system : listed).filter(
          (item) => item.file === named.file && item.title.includes(named.title),
        )
        expect
          .soft(
            found.length > 0,
            `class ${entry.id} (${fault.fault}): "${named.title}" in ${named.file} is not in the fault suite`,
          )
          .toBe(true)
        // A fixme is listed but never runs, so it cannot cover a fault; name the gap instead.
        expect
          .soft(
            found.some((item) => !item.fixme),
            `class ${entry.id} (${fault.fault}): "${named.title}" in ${named.file} is a fixme`,
          )
          .toBe(found.length > 0)
      }
    }
  }
  // Every numbered class of section 12 is present.
  expect(faultClasses.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
})

for (const entry of faultClasses) {
  for (const fault of entry.faults.filter((item) => item.gap)) {
    test.fixme(`fault class ${entry.id}, ${fault.fault}: ${fault.gap}`, async () => {})
  }
}
