import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type LatencySample = { name: string; ms: number; status: 'passed' | 'failed'; error?: string }

/** Raw observations, written after each timed operation so a later failure retains earlier samples. */
export class PerformanceSamples {
  readonly samples: LatencySample[] = []
  readonly details: Record<string, unknown> = {}
  private readonly pending = new Map<number, { name: string; started: number }>()
  private next = 0
  private readonly file: string
  private readonly metadata: Record<string, unknown>

  constructor(file: string, metadata: Record<string, unknown>) {
    this.file = file
    this.metadata = metadata
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.jsonl`, `${JSON.stringify({ type: 'metadata', ...metadata })}\n`, { flag: 'wx' })
  }

  record(sample: LatencySample): void {
    if (!Number.isFinite(sample.ms) || sample.ms < 0) throw new Error('Invalid performance duration')
    this.samples.push(sample)
    appendFileSync(`${this.file}.jsonl`, `${JSON.stringify({ type: 'sample', ...sample })}\n`)
  }

  async measure<T>(name: string, action: () => Promise<T>): Promise<T> {
    const id = ++this.next
    appendFileSync(`${this.file}.jsonl`, `${JSON.stringify({ type: 'started', id, name })}\n`)
    const started = performance.now()
    this.pending.set(id, { name, started })
    try {
      const value = await action()
      this.record({ name, ms: performance.now() - started, status: 'passed' })
      return value
    } catch (error) {
      this.record({ name, ms: performance.now() - started, status: 'failed', error: String(error) })
      throw error
    } finally {
      this.pending.delete(id)
    }
  }

  finish(status: string, errors: string[] = []): void {
    const report = {
      version: 1,
      ...this.metadata,
      status,
      errors,
      details: this.details,
      samples: this.samples,
      incompleteSamples: [...this.pending.values()].map(({ name, started }) => ({
        name,
        status: 'incomplete',
        elapsedMs: performance.now() - started,
      })),
    }
    writeFileSync(this.file, `${JSON.stringify(report, null, 2)}\n`)
  }
}
