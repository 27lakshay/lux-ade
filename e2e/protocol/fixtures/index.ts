// The protocol E2E test API. Specs import `test` and `expect` from here, never
// from @playwright/test directly, so every test gets the harness teardown.
import { test as base, expect, type TestInfo } from '@playwright/test'
import { access, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scratchEnvironment } from './environment'
import { ScratchRepo } from './git'
import { ProcessLedger } from './processes'
import { ScratchProfile, type ProfileOptions } from './profile'

export { expect }
export { ScratchProfile, type CliResult, type Hello, type ProfileOptions } from './profile'
export { ScratchRepo } from './git'
export { codexPrompts, prompts, turnReply, type MockCall, type MockProvider } from './providers'
export {
  answerFor,
  answerIntent,
  cancellationIntent,
  cancelActiveSubmission,
  choiceAnswer,
  conversationStatus,
  fixtureAnswers,
  send,
  startConversation,
  waitForIdle,
  waitForMessage,
  waitForPendingRequest,
  type PendingRequest,
} from './conversations'
export { subscribeFeed } from './feed'
export { isRunning } from './processes'
export { primaryShell } from './terminals'

/** Owns everything one test starts: its temp root, profiles, repositories and processes. */
export class AdeHarness {
  readonly ledger = new ProcessLedger()
  private readonly profiles: ScratchProfile[] = []
  private repositories = 0
  private readonly timingOrigin = performance.now()
  private readonly timings: Array<{
    phase: string
    offsetMs: number
    durationMs: number
    status: 'passed' | 'failed'
  }> = []

  /** Durations can overlap: fixture use includes dependent fixture setup and test execution. */
  async measure<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now()
    let status: 'passed' | 'failed' = 'failed'
    try {
      const result = await operation()
      status = 'passed'
      return result
    } finally {
      this.timings.push({
        phase,
        offsetMs: started - this.timingOrigin,
        durationMs: performance.now() - started,
        status,
      })
    }
  }

  async attachTimings(): Promise<void> {
    await this.testInfo.attach('fixture-phases.json', {
      body: JSON.stringify({ version: 1, overlaps: true, phases: this.timings }),
      contentType: 'application/json',
    })
  }
  private constructor(
    readonly root: string,
    private readonly testInfo: TestInfo,
  ) {}

  static async create(testInfo: TestInfo): Promise<AdeHarness> {
    // Short prefix: Unix socket paths under it must stay below 104 bytes on macOS.
    return new AdeHarness(await mkdtemp(join(tmpdir(), 'ade-p-')), testInfo)
  }

  /** Start another scratch profile with its own daemon and runtime. */
  async profile(options: ProfileOptions = {}): Promise<ScratchProfile> {
    return this.measure('profile-startup', () =>
      ScratchProfile.start(join(this.root, `p${this.profiles.length + 1}`), this.ledger, options, (profile) =>
        this.profiles.push(profile),
      ),
    )
  }

  /** A new scratch Git repository with one commit on `main`. */
  async repo(
    options: { name?: string; branch?: string; initialFiles?: Record<string, string> } = {},
  ): Promise<ScratchRepo> {
    const name = options.name ?? `repo-${++this.repositories}`
    const home = join(this.root, 'git-home')
    return this.measure('repository-creation', async () => {
      await mkdir(home, { recursive: true })
      return ScratchRepo.create(join(this.root, 'repos', name), scratchEnvironment(home), options)
    })
  }

  /**
   * Stop every profile, then fail if any process this test owned is still
   * running. Survivors are killed so they cannot leak into other tests, but the
   * test still fails. The temp root is kept when anything failed.
   */
  async teardown(): Promise<void> {
    const failures: string[] = []
    for (const profile of this.profiles) {
      try {
        await this.measure('profile-shutdown', () => profile.stop())
      } catch (error) {
        failures.push(String(error))
      }
    }
    const survivors = await this.measure('process-ledger-cleanup', () => this.settledSurvivors())
    if (survivors.length) {
      for (const survivor of survivors) {
        try {
          process.kill(survivor.pid, 'SIGKILL')
        } catch {
          /* It exited meanwhile. */
        }
      }
      failures.push(
        `Processes owned by this test were still running after teardown and were killed:\n${survivors
          .map((survivor) => `  ${survivor.pid} (${survivor.role}): ${survivor.command}`)
          .join('\n')}`,
      )
    }
    const failed = failures.length > 0 || this.testInfo.status !== this.testInfo.expectedStatus
    if (failed) await this.attachDiagnostics(failures)
    if (failures.length) {
      throw new Error(`E2E cleanup failed; diagnostics retained at ${this.root}\n${failures.join('\n')}`)
    }
    if (!failed && process.env.ADE_E2E_KEEP !== '1') await rm(this.root, { recursive: true, force: true })
  }

  /** Owned processes still alive once they have had time to exit on their own after a confirmed stop. */
  private async settledSurvivors() {
    const deadline = Date.now() + 5_000
    let survivors = await this.ledger.survivors()
    while (survivors.length && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 50))
      survivors = await this.ledger.survivors()
    }
    return survivors
  }

  private async attachDiagnostics(failures: string[]): Promise<void> {
    await this.testInfo.attach('scratch-root.txt', { body: `${this.root}\n`, contentType: 'text/plain' })
    await this.testInfo.attach('owned-processes.json', {
      body: JSON.stringify(this.ledger.all(), null, 2),
      contentType: 'application/json',
    })
    if (failures.length)
      await this.testInfo.attach('teardown-failures.txt', { body: failures.join('\n\n'), contentType: 'text/plain' })
    for (const [index, profile] of this.profiles.entries()) {
      for (const file of profile.diagnosticFiles()) {
        if (
          !(await access(file.path).then(
            () => true,
            () => false,
          ))
        )
          continue
        // Read only the tail: an output flood must not allocate its full log during cleanup.
        const handle = await open(file.path, 'r')
        try {
          const { size } = await handle.stat()
          const body = Buffer.alloc(Math.min(size, 1024 * 1024))
          const { bytesRead } = await handle.read(body, 0, body.length, Math.max(0, size - body.length))
          await this.testInfo.attach(`p${index + 1}-${file.name}`, {
            body: body.subarray(0, bytesRead),
            contentType: 'text/plain',
          })
        } finally {
          await handle.close()
        }
      }
    }
  }
}

type Fixtures = {
  /** The test's harness; use it for extra profiles or repositories. */
  ade: AdeHarness
  /** A started scratch profile with deterministic provider mocks. Started on first use. */
  profile: ScratchProfile
  /** A scratch Git repository with one commit. Created on first use. */
  repo: ScratchRepo
}

export const test = base.extend<Fixtures>({
  // Playwright requires the first fixture argument to be a destructuring pattern.
  ade: async ({}, use, testInfo) => {
    const harness = await AdeHarness.create(testInfo)
    try {
      await harness.measure('fixture-use', () => use(harness))
    } finally {
      try {
        await harness.measure('teardown', () => harness.teardown())
      } finally {
        await harness.attachTimings()
      }
    }
  },
  profile: async ({ ade }, use) => {
    await use(await ade.profile())
  },
  repo: async ({ ade }, use) => {
    await use(await ade.repo())
  },
})
