// The desktop E2E test API: the protocol fixtures (a scratch profile with its
// daemon, runtime and provider mocks, scratch repositories, the process
// ledger) plus the built Electron app launched against that profile's socket.
// Specs import `test` and `expect` from here.
import { _electron as electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test as protocol, type AdeHarness, type ScratchProfile } from '../protocol/fixtures'
import { repositoryRoot } from '../protocol/fixtures/environment'
import { DesktopEvidence } from './evidence'

export * from '../protocol/fixtures'

const desktopDirectory = join(repositoryRoot, 'apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string

/** One launch of the desktop app: the Electron process and its first window. */
export type RunningDesktop = { app: ElectronApplication; window: Page }

/**
 * Launches the built, unpackaged desktop (`electron apps/desktop`) against a
 * scratch profile's daemon (`ADE_SOCKET`). Every launch of one test shares a
 * user-data directory under the test's temp root, so a relaunch finds the
 * previous launch's journals. No debugging or state port is opened, so a
 * running dev app keeps its ports, and windows stay hidden.
 */
export class DesktopLauncher {
  readonly userData: string
  private readonly evidence: DesktopEvidence
  private readonly running = new Set<ElectronApplication>()

  constructor(
    private readonly ade: AdeHarness,
    testInfo: TestInfo,
    private readonly target = { executablePath: electronExecutable, args: [desktopDirectory] },
  ) {
    this.evidence = new DesktopEvidence(testInfo)
    this.userData = join(ade.root, 'electron')
  }

  async launch(profile: ScratchProfile, env: Record<string, string> = {}): Promise<RunningDesktop> {
    const app = await electron.launch({
      executablePath: this.target.executablePath,
      args: this.target.args,
      cwd: profile.defaultWorkspaceRoot,
      env: {
        ...profile.env,
        ADE_SOCKET: profile.socket,
        ADE_E2E_USER_DATA_DIR: this.userData,
        ADE_E2E_HIDE_WINDOW: process.env.ADE_DESKTOP_HEADED === '1' ? '0' : '1',
        ADE_DEBUG_PORT: '0',
        ADE_DEV_STATE_PORT: '0',
        ...env,
      },
    })
    this.running.add(app)
    const pid = app.process().pid
    if (typeof pid === 'number') await this.ade.ledger.own(pid, 'electron')
    await this.evidence.start(app)
    const window = await app.firstWindow()
    // The URL, and with it the window's record, is known once the app page has loaded.
    await window.waitForURL(
      env.ELECTRON_RENDERER_URL ? (url) => url.origin === new URL(env.ELECTRON_RENDERER_URL!).origin : /^ade:\/\/app\//,
      { waitUntil: 'domcontentloaded' },
    )
    return { app, window }
  }

  /** Quit the app the way a person does (Cmd+Q): windows keep their daemon records. */
  async quit(desktop: RunningDesktop): Promise<void> {
    await this.ade.ledger.sweep()
    await this.evidence.stop(desktop.app)
    await desktop.app.close()
    this.running.delete(desktop.app)
  }

  /** Kill the app without letting it quit: no guard or teardown runs. */
  async kill(desktop: RunningDesktop): Promise<void> {
    await this.ade.ledger.sweep()
    await this.evidence.stop(desktop.app)
    const exited = new Promise<void>((resolveExit) => desktop.app.process().once('exit', () => resolveExit()))
    desktop.app.process().kill('SIGKILL')
    await exited
    this.running.delete(desktop.app)
  }

  async closeAll(): Promise<void> {
    await this.ade.ledger.sweep()
    for (const app of this.running) {
      await this.evidence.stop(app)
      await app.close().catch(() => app.process().kill('SIGKILL'))
    }
    this.running.clear()
    await this.evidence.finish()
  }
}

/** The record ID in a window's URL (`?window=<ID>`), which main sets when it opens the window. */
export function windowRecordOf(window: Page): string | null {
  return new URL(window.url()).searchParams.get('window')
}

export const test = protocol.extend<{ desktop: DesktopLauncher }>({
  // Torn down before `ade`, so the app has quit before the harness checks for survivors.
  desktop: async ({ ade }, use, testInfo) => {
    const launcher = new DesktopLauncher(ade, testInfo)
    try {
      await use(launcher)
    } finally {
      await launcher.closeAll()
    }
  },
})
