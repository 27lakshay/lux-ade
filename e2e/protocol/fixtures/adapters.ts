// Generic adapter fixtures (F024). `adapters/acp_agent.mjs` is a small ACP v1
// agent and `adapters/exec_agent.sh` a custom executable agent; neither calls
// a model. A spec stages private copies under its temp root, because an
// adapter's command must be an absolute path to an executable file, and a spec
// may change its copy to make a probe stale.
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScratchProfile } from './profile'

export type AdapterAgents = {
  /** Absolute path of the ACP agent copy. */
  acp: string
  /** Absolute path of the custom executable copy. */
  exec: string
  /** Where both agents record what they received. */
  dir: string
}

let stages = 0

/** Private, executable copies of both fixture agents and a directory for their records. */
export async function stageAdapterAgents(root: string): Promise<AdapterAgents> {
  const base = join(root, 'adapter-agents', String(++stages))
  const dir = join(base, 'records')
  await mkdir(dir, { recursive: true })
  const acp = join(base, 'acp_agent.mjs')
  const exec = join(base, 'exec_agent.sh')
  await copyFile(join(__dirname, 'adapters', 'acp_agent.mjs'), acp)
  await copyFile(join(__dirname, 'adapters', 'exec_agent.sh'), exec)
  await chmod(acp, 0o755)
  await chmod(exec, 0o755)
  return { acp, exec, dir }
}

/** Define an ACP adapter on the fixture agent and probe it. Returns its provider ID. */
export async function defineAcpAdapter(profile: ScratchProfile, agents: AdapterAgents, id = 'e2e-acp',
  env: Record<string, string> = {}): Promise<string> {
  await profile.call('adapter.put', { definition: { id, name: 'E2E ACP', kind: 'acp', command: agents.acp,
    env: { ACP_FIXTURE_DIR: agents.dir, ...env } } })
  const probed = await profile.call('adapter.probe', { id })
  if (probed.adapter.readiness !== 'ready') throw new Error(`Adapter ${id} is ${probed.adapter.readiness}: ${JSON.stringify(probed.adapter.probe)}`)
  return probed.adapter.provider_id
}

/** Define a custom executable adapter on the fixture script and probe it. Returns its provider ID. */
export async function defineExecAdapter(profile: ScratchProfile, agents: AdapterAgents, id = 'e2e-exec'): Promise<string> {
  await profile.call('adapter.put', { definition: { id, name: 'E2E executable', kind: 'executable', command: agents.exec,
    env: { EXEC_FIXTURE_DIR: agents.dir }, executable: { prompt_input: 'stdin', timeout_seconds: 60 } } })
  const probed = await profile.call('adapter.probe', { id })
  if (probed.adapter.readiness !== 'ready') throw new Error(`Adapter ${id} is ${probed.adapter.readiness}`)
  return probed.adapter.provider_id
}

export type AcpCall = { pid: number; id?: string | number; method?: string; params?: Record<string, unknown>;
  result?: Record<string, unknown> }

/** Every message the ACP fixture agent received, in order; empty before the first. */
export async function acpCalls(agents: AdapterAgents): Promise<AcpCall[]> {
  const text = await readFile(join(agents.dir, 'calls.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AcpCall)
}

/** The prompts the custom executable received, one per line. */
export async function execPrompts(agents: AdapterAgents): Promise<string[]> {
  const text = await readFile(join(agents.dir, 'prompts.txt'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean)
}

/** Let a held custom executable turn finish. */
export async function releaseExec(agents: AdapterAgents): Promise<void> {
  await writeFile(join(agents.dir, 'release'), '')
}
