// Git remotes for ordinary-Git E2E: bare repositories on this machine that
// stand in for forge hosts, and an SSH command that serves them. Nothing here
// contacts a network host or reads the user's SSH or Git configuration.
//
// - `bareRemote` creates a bare repository, optionally seeded with a repo's branch.
// - `forgeSsh` writes an executable that Git can use as `core.sshCommand`.
//   It maps `host` + repository path onto `<root>/<host>/<path>` and runs
//   `git upload-pack` or `git receive-pack` there, the way a forge's SSH
//   endpoint would. An unknown host fails like a refused key. Every call is
//   appended to `<dir>/calls.jsonl`.
// - `profileGitConfig` appends to the scratch profile's own global Git config,
//   which the daemon's Git reads through the scratch HOME.
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ScratchRepo } from './git'
import type { ScratchProfile } from './profile'

/** A new bare repository at `path`. With `seed`, pushes `seed`'s `branch` into it. */
export async function bareRemote(repo: ScratchRepo, path: string,
  seed?: { branch?: string }): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await repo.git('init', '--quiet', '--bare', '--initial-branch=main', path)
  if (seed) await repo.git('push', '--quiet', path, `${seed.branch ?? 'main'}:refs/heads/${seed.branch ?? 'main'}`)
  return path
}

/** The commit a bare repository's branch points at, or null when it has none. */
export async function remoteHead(repo: ScratchRepo, bare: string, branch = 'main'): Promise<string | null> {
  const out = await repo.git('--git-dir', bare, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`)
  return out.trim() || null
}

export type ForgeSsh = {
  /** Absolute path of the executable to set as `core.sshCommand`. */
  command: string
  /** Where host directories live: `<root>/<host>/<repository path>`. */
  root: string
  calls(): Promise<Array<{ host: string; program: string; path: string; exit?: number }>>
}

const sshScript = `#!/usr/bin/env node
// Stand-in forge SSH endpoint for E2E. See e2e/protocol/fixtures/git-remotes.ts.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const root = __ROOT__
const argv = process.argv.slice(2)
const words = []
for (let i = 0; i < argv.length; i++) {
  if (/^-[opiFlJ]$/.test(argv[i])) { i++; continue }
  if (argv[i].startsWith('-')) continue
  words.push(argv[i])
}
const target = words[0] ?? ''
const host = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target
const command = words.slice(1).join(' ')
const match = /^(git-upload-pack|git-receive-pack) '(.*)'$/.exec(command)
const log = (entry) => appendFileSync(join(here, 'calls.jsonl'), JSON.stringify({ host, ...entry }) + '\\n')
if (!match || !existsSync(join(root, host))) {
  log({ program: match?.[1] ?? command, path: match?.[2] ?? '', exit: 255 })
  process.stderr.write(host + ': Permission denied (publickey).\\n')
  process.exit(255)
}
const path = join(root, host, match[2].replace(/^\\/?~?\\/?/, ''))
log({ program: match[1], path: match[2] })
const child = spawn('git', [match[1].slice(4), path], { stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
`

/** An SSH command that serves bare repositories under `root/<host>/`. */
export async function forgeSsh(dir: string, root: string): Promise<ForgeSsh> {
  await mkdir(dir, { recursive: true })
  await mkdir(root, { recursive: true })
  const command = join(dir, 'forge-ssh.mjs')
  await writeFile(command, sshScript.replace('__ROOT__', JSON.stringify(root)))
  await chmod(command, 0o755)
  return {
    command,
    root,
    async calls() {
      const text = await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
  }
}

/** Append `text` to the profile's global Git config (its scratch HOME's .gitconfig). */
export async function profileGitConfig(profile: ScratchProfile, text: string): Promise<void> {
  await appendFile(join(profile.home, '.gitconfig'), text.endsWith('\n') ? text : `${text}\n`)
}
