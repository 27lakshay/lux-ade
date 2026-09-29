import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cpus, totalmem, release } from 'node:os'
import { execFileSync } from 'node:child_process'
import { test as base } from './index'
import { binaries, repositoryRoot } from './environment'
import { PerformanceSamples } from './performance-recording'
export { expect } from './index'

export const test = base.extend<{
  measurements: PerformanceSamples
  dispose: (cleanup: () => void | Promise<void>) => void
}>({
  measurements: [
    async ({}, use, testInfo) => {
      const file = testInfo.outputPath('performance.json')
      const hashes = Object.fromEntries(
        Object.entries(binaries).map(([name, path]) => [
          name,
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ]),
      )
      const measurements = new PerformanceSamples(file, {
        title: testInfo.title,
        workers: testInfo.config.workers,
        retries: testInfo.project.retries,
        mode: process.env.ADE_PERFORMANCE_DIAGNOSTICS === '1' ? 'diagnostic' : 'latency',
        buildMode: process.env.ADE_PERFORMANCE_BUILD_MODE ?? 'unverified',
        binarySha256: hashes,
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim() !== '',
        machine: {
          platform: process.platform,
          arch: process.arch,
          release: release(),
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
        },
        node: process.version,
        buildConfiguration: Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_TARGET_DIR|CARGO_BUILD_TARGET|CARGO_PROFILE_DEV_[A-Z_]+)$/.test(
              key,
            ),
          ),
        ),
        scope:
          'Headless real daemon/runtime; synthetic providers and browser owner. No Electron rendering or model latency.',
        deferred: [
          'Electron startup/rendering',
          'production conversation rendering',
          'slow full-history CLI TTY replay product gap',
        ],
        instrumentation:
          'Append raw samples after timed intervals; no tracing or forced GC. Diagnostic mode samples process resources separately.',
      })
      try {
        await use(measurements)
      } finally {
        measurements.finish(
          testInfo.status ?? 'interrupted',
          testInfo.errors.map((error) => error.message ?? String(error)),
        )
        await testInfo.attach('performance.json', { path: file, contentType: 'application/json' })
        await testInfo.attach('performance.jsonl', { path: `${file}.jsonl`, contentType: 'application/x-ndjson' })
      }
    },
    { auto: true },
  ],
  dispose: async ({ measurements }, use) => {
    const cleanups: Array<() => void | Promise<void>> = []
    try {
      await use((cleanup) => {
        cleanups.push(cleanup)
      })
    } finally {
      const errors: unknown[] = []
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      measurements.details.cleanupErrors = errors.map(String)
      if (errors.length) throw new AggregateError(errors, 'Performance resource cleanup failed')
    }
  },
})
