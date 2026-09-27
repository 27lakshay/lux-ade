// Scripted provider CLIs for readiness, managed-account and quota specs.
//
// A profile started with `clis.env` launches Codex, and checks Claude Code,
// through small executables installed under the test's temp root. A spec can
// uninstall one, or "update" it to another version, exactly as an external CLI
// update would. `--version` and Claude's `auth status` are answered by the
// shell script itself, so the account probes stay well inside their timeouts
// on a loaded host; Codex's app-server runs fake_codex.py, which starts
// scripts/fixtures/codex_mock.py for turns. Account credentials are fixture
// files inside each account's native home: nothing reads a real account, and
// no model is called.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdeHarness } from './index'
import type { MockCall } from './providers'

export type FakeCliProvider = 'codex' | 'claude'

/** The versions the account probes accept. */
export const compatibleVersions: Record<FakeCliProvider, string> = { codex: '0.157.0', claude: '2.1.300' }

/** An identity a fake CLI reports for an account home. */
export type FixtureIdentity = { email: string; account_id: string }

let python: string | null = null
function pythonPath(): string {
  python ??= execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  return python
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const credentialFile: Record<FakeCliProvider, string> = { codex: 'auth.json', claude: 'fixture-auth.json' }

export class FakeProviderClis {
  private constructor(readonly root: string) {}

  /** Install both CLIs at their compatible versions under the test's temp root. */
  static async create(ade: AdeHarness, name = 'clis'): Promise<FakeProviderClis> {
    const clis = new FakeProviderClis(join(ade.root, name))
    await mkdir(join(clis.root, 'bin'), { recursive: true })
    await mkdir(clis.mockDirectory, { recursive: true })
    await clis.install('codex', compatibleVersions.codex)
    await clis.install('claude', compatibleVersions.claude)
    return clis
  }

  /** Where the Codex fixture keeps calls.jsonl, launches.jsonl and release files. */
  get mockDirectory(): string {
    return join(this.root, 'codex-mock')
  }

  path(provider: FakeCliProvider): string {
    return join(this.root, 'bin', provider)
  }

  /** Daemon environment that routes provider executables to these CLIs. */
  get env(): Record<string, string> {
    return { ADE_CODEX_BIN: this.path('codex'), ADE_CLAUDE_BIN: this.path('claude') }
  }

  /**
   * Install, or replace in place, the CLI reporting `version`. With `hangs`,
   * `--version` never answers, like a CLI stuck on a lock or a prompt; the
   * probe's own timeout ends it.
   */
  async install(provider: FakeCliProvider, version: string, options: { hangs?: boolean } = {}): Promise<void> {
    const answer = (text: string) => (options.hangs ? 'exec tail -f /dev/null' : `echo ${quoted(text)}; exit 0`)
    const body =
      provider === 'codex'
        ? [
            '#!/bin/sh',
            `if [ "$#" -eq 1 ] && [ "$1" = --version ]; then ${answer(`codex-cli ${version}`)}; fi`,
            `ADE_MOCK_DIR=${quoted(this.mockDirectory)} exec ${quoted(pythonPath())} ${quoted(join(__dirname, 'fake_codex.py'))} "$@"`,
          ]
        : [
            '#!/bin/sh',
            `if [ "$#" -eq 1 ] && [ "$1" = --version ]; then ${answer(`${version} (Claude Code)`)}; fi`,
            'if [ "$3" = auth ] && [ "$4" = status ]; then',
            `  if [ -f "$CLAUDE_CONFIG_DIR/${credentialFile.claude}" ]; then cat "$CLAUDE_CONFIG_DIR/${credentialFile.claude}"; exit 0; fi`,
            '  echo \'{"loggedIn":false}\'; exit 1',
            'fi',
            'echo "The fixture Claude CLI scripts only --version and auth status" >&2; exit 2',
          ]
    const target = this.path(provider)
    // Write a new file and move it over the old one, as a package manager does.
    await writeFile(`${target}.new`, `${body.join('\n')}\n`, { mode: 0o755 })
    await rename(`${target}.new`, target)
  }

  async uninstall(provider: FakeCliProvider): Promise<void> {
    await rm(this.path(provider), { force: true })
  }

  /** Sign an account home in as `identity`, with the private credential file the probe requires. */
  async signIn(provider: FakeCliProvider, nativeHome: string, identity: FixtureIdentity): Promise<void> {
    await this.writeCredential(
      provider,
      nativeHome,
      JSON.stringify(
        provider === 'codex'
          ? identity
          : {
              loggedIn: true,
              authMethod: 'claude.ai',
              apiProvider: 'firstParty',
              configDirectory: nativeHome,
              email: identity.email,
              orgId: identity.account_id,
            },
      ),
    )
  }

  /** Leave a credential the provider no longer accepts: a revoked Codex login, a signed-out Claude status. */
  async invalidateCredentials(provider: FakeCliProvider, nativeHome: string): Promise<void> {
    await this.writeCredential(provider, nativeHome, provider === 'codex' ? '{"revoked":true}' : '{"loggedIn":false}')
  }

  /** Every call the Codex mock recorded behind this CLI. */
  async codexCalls(): Promise<MockCall[]> {
    return jsonLines<MockCall>(join(this.mockDirectory, 'calls.jsonl'))
  }

  /** Every Codex app-server start, with the CODEX_HOME it ran under. Account probes appear here too. */
  async codexLaunches(): Promise<Array<{ pid: number; codex_home: string | null; args: string[] }>> {
    return jsonLines(join(this.mockDirectory, 'launches.jsonl'))
  }

  /** Make every later Codex rate-limit report say the window is exhausted. */
  async exhaustCodexLimits(): Promise<void> {
    await writeFile(join(this.mockDirectory, 'exhaust'), '')
  }

  private async writeCredential(provider: FakeCliProvider, nativeHome: string, content: string): Promise<void> {
    const file = join(nativeHome, credentialFile[provider])
    // A fresh private file: the Codex probe refuses a shared or linked one.
    await rm(file, { force: true })
    await writeFile(file, content, { mode: 0o600 })
  }
}

async function jsonLines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}
