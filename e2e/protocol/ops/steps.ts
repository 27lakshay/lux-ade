// Shared steps for the ops specs: retention, diagnostics and resource
// visibility. They drive the public protocol; file-system steps only plant or
// age files in the profile's own scratch directories.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type ScratchProfile } from '../fixtures'
import { configureService, nodeService, waitForReadiness, writeServicePrograms } from '../fixtures/services'

export const DAY_MS = 24 * 60 * 60 * 1000

/** The runtime's durable service and script log directory. */
export function serviceLogDirectory(profile: ScratchProfile): string {
  return join(profile.dataDirectory, 'service-logs')
}

/** The daemon's diagnostic log directory (ADE_LOG_DIR is not set, so it is `<data>/logs`). */
export function diagnosticLogDirectory(profile: ScratchProfile): string {
  return join(profile.dataDirectory, 'logs')
}

/** Names in `directory`, or none when it does not exist. */
export async function names(directory: string): Promise<string[]> {
  return (await readdir(directory).catch(() => [] as string[])).sort()
}

/** Move a file's access and modification times `days` into the past. */
export async function age(path: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * DAY_MS)
  await utimes(path, when, when)
}

/**
 * Plant a service log the way the runtime names one (64 hex digits, then a
 * part) that no terminal or service owns, as a deleted workspace leaves
 * behind, idle for `days`.
 */
export async function plantOrphanServiceLog(profile: ScratchProfile, days: number, body = 'orphan output\n'): Promise<string> {
  const directory = serviceLogDirectory(profile)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const key = randomBytes(32).toString('hex')
  await writeFile(join(directory, `${key}.0`), body)
  await age(join(directory, `${key}.0`), days)
  return key
}

/** Plant a rotated diagnostic log `<process>.<date>.jsonl`, aged `days`. */
export async function plantDiagnosticLog(profile: ScratchProfile, process: string, date: string, days: number,
  lines: unknown[] = [{ fields: { event: 'process_started' } }]): Promise<string> {
  const directory = diagnosticLogDirectory(profile)
  await mkdir(directory, { recursive: true })
  const name = `${process}.${date}.jsonl`
  await writeFile(join(directory, name), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  await age(join(directory, name), days)
  return name
}

/** Start a node HTTP service in `workspacePath` and return its workspace, start reply and log keys. */
export async function startService(profile: ScratchProfile, workspacePath: string, name: string,
  env: Record<string, string> = {}) {
  const { workspace } = await profile.call('workspace.open', { path: workspacePath })
  const files = await writeServicePrograms(workspacePath)
  const before = new Set(await names(serviceLogDirectory(profile)))
  const service = await configureService(profile, workspace.id, name, nodeService(files.server, { env }))
  const started = await profile.call('service.start', { workspace_id: workspace.id, name })
  await waitForReadiness(profile, workspace.id, name, 'tcp_listening')
  let keys: string[] = []
  await expect.poll(async () => {
    keys = [...new Set((await names(serviceLogDirectory(profile))).filter((file) => !before.has(file))
      .map((file) => file.split('.')[0]))]
    return keys.length
  }, { message: 'the service to write its durable log' }).toBeGreaterThan(0)
  return { workspace, service, started, logKeys: keys }
}
