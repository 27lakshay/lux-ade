// Evidence for manually launched Electron contexts; ordinary timing runs leave this off.
import type { ElectronApplication, TestInfo } from '@playwright/test'
import { rm, stat } from 'node:fs/promises'

export type DesktopTraceMode = 'off' | 'on' | 'retain-on-failure'

export function desktopTraceMode(value = process.env.ADE_DESKTOP_TRACE ?? 'off'): DesktopTraceMode {
  if (value !== 'off' && value !== 'on' && value !== 'retain-on-failure')
    throw new Error('ADE_DESKTOP_TRACE must be off, on or retain-on-failure')
  return value
}

/** Own trace sessions separately from app shutdown, so quit/kill still happen if collection fails. */
export class DesktopEvidence {
  private readonly active = new Map<ElectronApplication, { name: string; path: string }>()
  private readonly completed: Array<{ name: string; path: string }> = []
  private readonly errors: string[] = []
  private launches = 0
  private retainedBytes = 0

  constructor(
    private readonly testInfo: TestInfo,
    private readonly mode = desktopTraceMode(),
  ) {}

  async start(app: ElectronApplication): Promise<void> {
    if (this.mode === 'off') return
    const name = `electron-${++this.launches}.zip`
    const path = this.testInfo.outputPath(name)
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    this.active.set(app, { name, path })
  }

  async stop(app: ElectronApplication): Promise<void> {
    const record = this.active.get(app)
    if (!record) return
    this.active.delete(app)
    try {
      await app.context().tracing.stop({ path: record.path })
      const bytes = (await stat(record.path)).size
      if (this.retainedBytes + bytes > 100 * 1024 * 1024) {
        await rm(record.path)
        throw new Error(`${record.name} exceeded the 100 MiB total trace limit for this test; select a narrower test`)
      }
      this.retainedBytes += bytes
      this.completed.push(record)
    } catch (error) {
      this.errors.push(`${record.name}: ${String(error)}`)
    }
  }

  async finish(): Promise<void> {
    const failed = this.testInfo.status !== this.testInfo.expectedStatus
    for (const record of this.completed) {
      if (this.mode === 'on' || failed)
        await this.testInfo.attach(record.name, { path: record.path, contentType: 'application/zip' })
      // Playwright copies attached files into its artifact directory. Keep that copy only.
      await rm(record.path, { force: true })
    }
    if (this.errors.length) {
      const message = this.errors.join('\n')
      await this.testInfo.attach('electron-trace-errors.txt', { body: message, contentType: 'text/plain' })
      if (!failed) throw new Error(`Electron tracing failed: ${message}`)
    }
  }
}
