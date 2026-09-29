import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { resolve } from 'node:path'
import type { FullConfig, FullResult, Reporter } from '@playwright/test/reporter'
// Pure adapter shared with Node regression tests.
// @ts-expect-error JavaScript reporting adapter is verified by its Node tests.
import { summarizePlaywright } from '../scripts/report-summary.mjs'

export default class RunReporter implements Reporter {
  private readonly started = Date.now()
  private config?: FullConfig
  private failure?: string
  constructor(private readonly options: { directory: string; suite: string; invocationId: string }) {}
  private write(name: string, value: unknown) {
    mkdirSync(this.options.directory, { recursive: true })
    writeFileSync(resolve(this.options.directory, name), JSON.stringify(value, null, 2) + '\n')
  }
  onBegin(config: FullConfig) {
    this.config = config
    try {
      this.write('run.json', this.metadata('running'))
    } catch (error) {
      this.failure = String(error)
    }
  }
  private metadata(status: string) {
    const git = (args: string[]) => {
      try {
        return execFileSync('git', args, { encoding: 'utf8', timeout: 5000 }).trim()
      } catch {
        return null
      }
    }
    const dirty = git(['status', '--porcelain'])
    return {
      suite: this.options.suite,
      acceptanceScope: this.config?.metadata.acceptanceScope ?? null,
      status,
      startedAt: new Date(this.started).toISOString(),
      wallMs: Date.now() - this.started,
      revision: git(['rev-parse', 'HEAD']),
      dirty: dirty === null ? null : dirty !== '',
      machine: { os: platform(), arch: arch(), release: release() },
      tools: { node: process.version, playwright: this.config?.version ?? null },
      command: process.argv.slice(1),
      workers: this.config?.workers ?? null,
      shard: this.config?.shard?.current ?? 1,
      shardCount: this.config?.shard?.total ?? 1,
      cacheCondition: process.env.ADE_TEST_CACHE_CONDITION ?? 'unspecified',
      phases: { buildMs: null },
      nativeReport: 'native.json',
    }
  }
  onEnd(result: FullResult) {
    try {
      if (this.failure) throw new Error(this.failure)
      const native = JSON.parse(readFileSync(resolve(this.options.directory, 'native.json'), 'utf8'))
      let prerequisites = null
      let unexecutedTests = null
      try {
        const report = JSON.parse(readFileSync(resolve(this.options.directory, 'prerequisites.json'), 'utf8'))
        if (report.invocationId === this.options.invocationId && report.suite === this.options.suite)
          prerequisites = { status: report.status, inventoryError: report.inventoryError ?? null }
        if (prerequisites?.status === 'unavailable' && !prerequisites.inventoryError) {
          const inventory = JSON.parse(
            readFileSync(resolve(this.options.directory, 'prerequisite-inventory.json'), 'utf8'),
          )
          if (inventory.invocationId !== this.options.invocationId) throw new Error('Stale prerequisite inventory')
          unexecutedTests = summarizePlaywright(inventory.native, { status: 'failed' }).tests.map(
            (entry: { status: string }) => ({
              ...entry,
              status: 'unexecuted',
              evidence: 'native-discovery-only',
            }),
          )
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const summary = summarizePlaywright(native, { ...this.metadata(result.status), prerequisites, unexecutedTests })
      this.write('summary.json', summary)
      this.write('run.json', {
        ...this.metadata(summary.status),
        summary: 'summary.json',
        prerequisites,
        failureCategory: summary.failureCategory,
      })
      console.log(`Test report: ${this.options.directory}`)
      return {
        status:
          summary.status === 'passed'
            ? ('passed' as const)
            : summary.status === 'interrupted'
              ? ('interrupted' as const)
              : ('failed' as const),
      }
    } catch (error) {
      console.error(`Test reporting failed: ${String(error)}`)
      return { status: 'failed' as const }
    }
  }
}
