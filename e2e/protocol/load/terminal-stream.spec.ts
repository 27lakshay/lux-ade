import { test, expect } from '../fixtures/performance'
import { primaryShell, TerminalStream, terminalMetrics } from '../fixtures/terminals'
import { slowViewer, type ViewerReport } from '../terminals2/slow-viewer'
import { restoredScreen, type ScreenState } from '../terminals2/viewer'

test('terminal streaming: three slow SDK/desktop adapter viewers resync and resume live output @load', async ({
  ade,
  measurements,
  dispose,
}) => {
  test.setTimeout(480_000)
  measurements.details.workload = {
    samples: 3,
    linesPerSample: 360_000,
    viewerBytesPerMs: 200,
    input: 'seq 1 360000; echo "flo""od-end"',
    ready: 'viewer restores initial Ghostty snapshot before flood',
    completion: 'resync observed; released viewer agrees with fresh snapshot, then receives live marker',
    polling: '100 ms observation interval; durations include detection latency',
    surface: 'SDK, TerminalFeed and Ghostty WASM on a worker; no Electron drawing',
  }
  for (let sample = 0; sample < 3; sample++) {
    const profile = await measurements.measure(`stream.${sample}.profile`, () => ade.profile())
    try {
      const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
      const terminal = await primaryShell(profile, workspace.id)
      const target = [workspace.id, terminal] as const
      const stream = TerminalStream.open(profile, ...target)
      dispose(() => stream.close())
      const initial = await stream.snapshot()
      const viewer = await slowViewer(profile, ...target, 200)
      try {
        await expect.poll(async () => (await viewer.report()).feed.ready).toBe(true)
        await measurements.measure(`stream.${sample}.first-resync`, async () => {
          stream.send({ op: 'input', run_id: initial.run_id, data: 'seq 1 360000; echo "flo""od-end"\n' })
          stream.close()
          await expect
            .poll(async () => (await terminalMetrics(profile, ...target))!.viewer_resyncs, {
              timeout: 120_000,
              intervals: [100],
            })
            .toBeGreaterThanOrEqual(1)
        })
        let settled: { report: ViewerReport; fresh: ScreenState; bytes: number } | undefined
        await measurements.measure(`stream.${sample}.catch-up`, async () => {
          viewer.release()
          await expect
            .poll(
              async () => {
                const report = await viewer.report()
                const fresh = TerminalStream.open(profile, ...target, { op: 'subscribe', snapshot_format: 'binary' })
                try {
                  const snapshot = await fresh.snapshot()
                  const bytes = (snapshot.metrics as { terminal_bytes: number }).terminal_bytes
                  if (report.sdk.offset !== bytes || !report.screen.lines.includes('flood-end')) return false
                  settled = { report, fresh: await restoredScreen(snapshot), bytes }
                  return true
                } finally {
                  fresh.close()
                }
              },
              { timeout: 90_000, intervals: [100] },
            )
            .toBe(true)
          expect(settled!.bytes).toBeGreaterThan(2_500_000)
          expect(settled!.report.sdk.resyncs).toBeGreaterThanOrEqual(1)
          expect(settled!.report.resyncs).toBe(settled!.report.sdk.resyncs)
          expect(settled!.report).toMatchObject({
            errors: [],
            statuses: [],
            closed: null,
            feed: { failed: false, ready: true },
          })
          expect(settled!.report.screen).toEqual(settled!.fresh)
        })
        measurements.details[`stream.${sample}`] = { bytes: settled!.bytes, resyncs: settled!.report.resyncs }
        await measurements.measure(`stream.${sample}.live-output`, async () => {
          const sent = await profile.cli('terminal', 'send', ...target, 'echo "af""ter-resync"')
          expect(sent.code, sent.stderr).toBe(0)
          await expect
            .poll(async () => (await viewer.report()).screen.lines.includes('after-resync'), { intervals: [100] })
            .toBe(true)
        })
        expect(await terminalMetrics(profile, ...target)).toMatchObject({ run_id: initial.run_id, shell_running: true })
        if (process.env.ADE_PERFORMANCE_DIAGNOSTICS === '1') {
          const status = await profile.call('diagnostics.status', {})
          measurements.details[`resources.${sample}`] = status.resources
          expect(status.resources.observed).toBe(true)
        }
      } finally {
        await viewer.close()
      }
    } finally {
      await profile.stop()
    }
  }
})
