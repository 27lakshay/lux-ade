import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ReporterDescription } from '@playwright/test'

export function reporting(suite: string): {
  outputDir: string
  reporter: ReporterDescription[]
  metadata: { testReporting: { directory: string; suite: string; invocationId: string } }
} {
  // Workers reload configuration; inherit one ID so their attachments share the parent run.
  const runId = (process.env.ADE_REPORT_RUN_ID ??= randomUUID())
  const directory = resolve(process.env.ADE_TEST_REPORT_ROOT ?? 'test-results/runs', `${suite}-${runId}`)
  const invocationId = randomUUID()
  return {
    metadata: { testReporting: { directory, suite, invocationId } },
    outputDir: resolve(directory, 'artifacts'),
    reporter: [
      ['list'],
      ...(process.env.ADE_TEST_HTML === '1'
        ? ([['html', { outputFolder: resolve(directory, 'html'), open: 'never' }]] as ReporterDescription[])
        : []),
      ['json', { outputFile: resolve(directory, 'native.json') }],
      ['./e2e/run-reporter.ts', { directory, suite, invocationId }],
    ],
  }
}
