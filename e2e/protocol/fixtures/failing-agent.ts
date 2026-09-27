// A custom executable agent whose turn fails on request (F024 executable
// adapter). A prompt containing "fail" writes an error and exits with status
// 3, which the runtime settles as a failed turn; any other prompt prints
// "Echo: <prompt>". It never calls a model. A spec gets a private copy under
// its temp root, because an adapter's command must be an absolute path.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScratchProfile } from './profile'

const SCRIPT = `#!/bin/sh
input=$(cat)
printf '%s\\n' "$input" >> "$FAILING_AGENT_DIR/prompts.txt"
case "$input" in
  *fail*)
    printf 'fixture failure\\n' >&2
    exit 3
    ;;
esac
printf 'Echo: %s' "$input"
`

export type FailingAgent = {
  /** The provider ID of the probed adapter. */
  provider: string
  /** Where the agent records each prompt it received. */
  dir: string
}

let stages = 0

/** Stage the agent, define it as a custom executable adapter on `profile` and probe it. */
export async function defineFailingAgent(
  profile: ScratchProfile,
  root: string,
  id = 'e2e-failing',
): Promise<FailingAgent> {
  const base = join(root, 'failing-agent', String(++stages))
  const dir = join(base, 'records')
  await mkdir(dir, { recursive: true })
  const command = join(base, 'failing_agent.sh')
  await writeFile(command, SCRIPT)
  await chmod(command, 0o755)
  await profile.call('adapter.put', {
    definition: {
      id,
      name: 'E2E failing agent',
      kind: 'executable',
      command,
      env: { FAILING_AGENT_DIR: dir },
      executable: { prompt_input: 'stdin', timeout_seconds: 60 },
    },
  })
  const probed = await profile.call('adapter.probe', { id })
  if (probed.adapter.readiness !== 'ready') throw new Error(`Adapter ${id} is ${probed.adapter.readiness}`)
  return { provider: probed.adapter.provider_id, dir }
}

/** The prompts the agent received, one per line. */
export async function failingAgentPrompts(agent: FailingAgent): Promise<string[]> {
  const text = await readFile(join(agent.dir, 'prompts.txt'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean)
}
