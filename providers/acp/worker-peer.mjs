// Test support: drives `worker.mjs` over the provider worker protocol, as the runtime does.
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url))
export const fixturePath = fileURLToPath(new URL('../../e2e/protocol/fixtures/adapters/acp_agent.mjs', import.meta.url))

/** A private copy of the deterministic ACP fixture agent with its own record directory. */
export async function stageFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ade-acp-worker-'))
  const command = join(dir, 'acp_agent.mjs')
  await copyFile(fixturePath, command)
  await chmod(command, 0o755)
  return { dir, command }
}

export async function agentCalls(dir) {
  const text = await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Starts the worker on an agent and returns a JSON-RPC client for it. */
export function startWorker({ command, args = [], env = {}, name = 'Fixture ACP', cwd = process.cwd() }) {
  const child = spawn(process.execPath, [workerPath], {
    cwd,
    env: {
      ...process.env,
      ADE_PROVIDER_ID: 'adapter:fixture',
      ADE_ACP_AGENT: JSON.stringify({ name, command, args, env }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames = []
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })
  let buffered = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line) frames.push(JSON.parse(line))
    }
  })
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)))
  let id = 0
  const request = async (method, params = {}, timeoutMs = 15_000) => {
    const current = ++id
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const response = frames.find((frame) => frame.id === current)
      if (response) {
        frames.splice(frames.indexOf(response), 1)
        if (response.error) {
          const error = new Error(response.error.data?.message ?? response.error.message)
          error.data = response.error.data
          throw error
        }
        return response.result
      }
      await sleep(5)
    }
    throw new Error(`Timed out waiting for ${method}; stderr: ${stderr}`)
  }
  const events = () => frames.filter((frame) => frame.method === 'event').map((frame) => frame.params)
  const waitFor = async (predicate, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = events().find(predicate)
      if (found) return found
      await sleep(5)
    }
    throw new Error(`Timed out waiting for an event; got ${JSON.stringify(events())}; stderr: ${stderr}`)
  }
  const initialize = () => request('initialize', { versions: [2], provider: 'adapter:fixture' })
  const stop = async () => {
    child.stdin.end()
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')])
    if (code === 'timeout') child.kill('SIGKILL')
    return code
  }
  return { child, request, events, waitFor, initialize, stop, exited, stderr: () => stderr }
}
