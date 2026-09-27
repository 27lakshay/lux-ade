// The environment every process a protocol spec starts runs with. It strips
// what the caller's shell could leak into a scratch profile, and points HOME at
// a scratch directory so no provider, Git or ADE code can read or write the real
// user profile, accounts or credentials.
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { secretStoreEnvironment } from './secret-store'

/** The repository checkout these fixtures belong to. */
export const repositoryRoot = resolve(__dirname, '../../..')
export const binaries = {
  daemon: join(repositoryRoot, 'target/debug/ade-daemon'),
  runtime: join(repositoryRoot, 'target/debug/ade-runtime'),
  cli: join(repositoryRoot, 'apps/cli/dist/index.js'),
  client: join(repositoryRoot, 'packages/client/dist/index.js'),
}

// Inherited names that select a profile, a data directory, a provider home or a
// credential, or that retarget Git at another repository.
const leakedPrefixes = [
  'ADE_',
  'CODEX_',
  'CLAUDE_',
  'ANTHROPIC_',
  'OPENAI_',
  'OMP_',
  'GIT_',
  'ANDROID_',
  'GH_',
  'GITHUB_',
  'AWS_',
  'SSH_AUTH_SOCK',
]

let interpreterPath: string | null = null

/**
 * Put the real node and python3 first on PATH. Version-manager shims (mise,
 * asdf, pyenv) read their configuration from HOME, which the scratch
 * environment replaces, so the provider fixtures' `#!/usr/bin/env python3`
 * must not reach a shim.
 */
function interpreterDirectories(): string {
  if (interpreterPath === null) {
    const directories = [dirname(process.execPath)]
    try {
      const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
      if (python) directories.push(dirname(python))
    } catch {
      /* A spec that needs python3 reports the missing interpreter itself. */
    }
    interpreterPath = [...new Set(directories)].join(':')
  }
  return interpreterPath
}

/**
 * The start of every scratch global Git config. The daemon's Git drops
 * `GIT_CONFIG_NOSYSTEM` (see `neutral` in the daemon), so it still reads the
 * Xcode Git's built-in config, which names the `osxkeychain` credential helper.
 * The empty `helper` resets that list, so no Git a spec starts can reach the
 * login keychain (machine safety, AGENTS.md). A spec that needs a helper
 * appends its own after this line.
 */
export function scratchGitConfig(name = 'ADE E2E', email = 'e2e@example.invalid'): string {
  return `[user]\n\tname = ${name}\n\temail = ${email}\n[credential]\n\thelper =\n`
}

/** A clean environment rooted at `home`, plus `extra`. */
export function scratchEnvironment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name === 'NO_COLOR') continue
    if (leakedPrefixes.some((prefix) => name.startsWith(prefix))) continue
    base[name] = value
  }
  return {
    ...base,
    PATH: `${interpreterDirectories()}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    SHELL: '/bin/sh',
    // Every daemon a spec starts keeps secrets in a file in the scratch HOME,
    // never in the Keychain (machine safety, AGENTS.md).
    ...secretStoreEnvironment(home),
    ...extra,
  }
}
