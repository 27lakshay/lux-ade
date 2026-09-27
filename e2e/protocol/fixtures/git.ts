// Scratch Git repositories. Each one lives under the test's temp root and runs
// Git with the scratch environment, so no global or system Git config applies.
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class ScratchRepo {
  private constructor(
    readonly path: string,
    private readonly env: Record<string, string>,
  ) {}

  /** `git init` a new repository at `path` with one initial commit. */
  static async create(
    path: string,
    env: Record<string, string>,
    options: { branch?: string; initialFiles?: Record<string, string> } = {},
  ): Promise<ScratchRepo> {
    await mkdir(path, { recursive: true })
    const repo = new ScratchRepo(await realpath(path), env)
    await repo.git('init', '--quiet', `--initial-branch=${options.branch ?? 'main'}`)
    await repo.git('config', 'user.name', 'ADE E2E')
    await repo.git('config', 'user.email', 'e2e@example.invalid')
    await repo.git('config', 'commit.gpgsign', 'false')
    await repo.commit('Initial commit', options.initialFiles ?? { 'README.md': '# Scratch repository\n' })
    return repo
  }

  /** Run Git in this repository and return stdout without trailing newlines; a non-zero exit throws. */
  async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.path, env: this.env, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trimEnd()
  }

  async write(relativePath: string, content: string): Promise<void> {
    const target = join(this.path, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  async read(relativePath: string): Promise<string> {
    return readFile(join(this.path, relativePath), 'utf8')
  }

  /**
   * Write `files`, stage exactly those paths, commit, and return the new HEAD.
   * Other changes in the tree stay as they are. With no files, commits what is already staged.
   */
  async commit(message: string, files: Record<string, string> = {}): Promise<string> {
    for (const [path, content] of Object.entries(files)) await this.write(path, content)
    const paths = Object.keys(files)
    if (paths.length) await this.git('add', '--', ...paths)
    await this.git('commit', '--quiet', '--allow-empty', '-m', message)
    return this.head()
  }

  /** Stage every change, including untracked files, commit, and return the new HEAD. */
  async commitAll(message: string): Promise<string> {
    await this.git('add', '--all')
    return this.commit(message)
  }

  async head(): Promise<string> {
    return this.git('rev-parse', 'HEAD')
  }

  /** An unstaged change to a tracked file (or a new untracked file). */
  async dirty(relativePath = 'README.md', content = '# Scratch repository\n\nAn unstaged edit.\n'): Promise<void> {
    await this.write(relativePath, content)
  }

  /**
   * A tracked file with one staged change and a further unstaged change on
   * top: index and worktree both differ from HEAD, and from each other.
   */
  async stagedAndUnstaged(relativePath = 'mixed.txt'): Promise<{ staged: string; unstaged: string }> {
    const exists = (await this.git('ls-files', '--', relativePath)).trim()
    if (!exists) await this.commit(`Add ${relativePath}`, { [relativePath]: 'line 1\nline 2\n' })
    const staged = 'line 1 staged\nline 2\n'
    const unstaged = 'line 1 staged\nline 2 unstaged\n'
    await this.write(relativePath, staged)
    await this.git('add', '--', relativePath)
    await this.write(relativePath, unstaged)
    return { staged, unstaged }
  }

  /** `git status --porcelain=v1` lines. */
  async status(): Promise<string[]> {
    const output = await this.git('status', '--porcelain=v1', '--untracked-files=all')
    return output ? output.split('\n') : []
  }
}
