// The faulty backend plugin fixture (`plugins/faulty`): an `e2e.faulty`
// backend whose activation fails, exits or hangs while a switch file exists
// in its `out_dir`, with a command that freezes its host and one that floods
// its log. Install it with `installAndEnable` from `./plugins`, which points
// `out_dir` at a directory the spec owns.
import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ActivationFault = 'fail-activate' | 'exit-activate' | 'hang-activate'

let copies = 0

/** A private copy of the faulty plugin under `root`. */
export async function stageFaultyPlugin(root: string): Promise<string> {
  const target = join(root, 'plugin-sources', `faulty-${++copies}`)
  await mkdir(join(root, 'plugin-sources'), { recursive: true })
  await cp(join(__dirname, 'plugins', 'faulty'), target, { recursive: true })
  return realpath(target)
}

/** Make every later activation fail in this way. */
export async function breakActivation(outDir: string, fault: ActivationFault): Promise<void> {
  await writeFile(join(outDir, fault), '')
}

/** Let later activations succeed again. */
export async function healActivation(outDir: string, fault: ActivationFault): Promise<void> {
  await rm(join(outDir, fault), { force: true })
}
