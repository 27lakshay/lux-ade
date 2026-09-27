// Directory snapshots for specs that must prove the daemon left files alone:
// every entry's kind, mode, size, modification time, content hash and link
// target, without following symbolic links.
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join, relative } from 'node:path'

export type TreeEntry = {
  kind: 'file' | 'directory' | 'symlink' | 'other'
  mode: number
  size: number
  mtimeMs: number
  sha256?: string
  target?: string
}

/** Every entry below `root`, keyed by its path relative to `root`. An absent root gives an empty snapshot. */
export async function treeSnapshot(root: string): Promise<Record<string, TreeEntry>> {
  const entries: Record<string, TreeEntry> = {}
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path).catch(() => null)
    if (!stat) return
    const key = relative(root, path) || '.'
    const base = { mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
    if (stat.isSymbolicLink()) {
      entries[key] = { kind: 'symlink', ...base, target: await readlink(path) }
    } else if (stat.isDirectory()) {
      entries[key] = { kind: 'directory', ...base }
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (stat.isFile()) {
      entries[key] = {
        kind: 'file',
        ...base,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      }
    } else {
      entries[key] = { kind: 'other', ...base }
    }
  }
  await visit(root)
  return entries
}
