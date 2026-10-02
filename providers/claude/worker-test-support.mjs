import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LIMITS, SDK_REQUIREMENTS, PROTOCOL_VERSION } from '@ade/provider-sdk'

export function startWorker({ env = {}, cwd, fixture = true, limits = {} } = {}) {
  const operations = [
    'initialize',
    'open',
    'send',
    'steer',
    'cancel',
    'answer',
    'compact',
    'rewind',
    'configure_mcp',
    'child_transcript',
    'history',
  ]
  const available = new Set([
    'initialize',
    'open',
    'send',
    'cancel',
    'answer',
    'configure_mcp',
    'history',
    'child_transcript',
    'rewind',
  ])
  const descriptor = {
    compatible_protocol_versions: [PROTOCOL_VERSION],
    name: 'Claude process verification',
    capabilities: [],
    permission_modes: ['default'],
    operations: operations.map((method) => ({
      method,
      tier:
        method === 'cancel'
          ? 'idempotent_command'
          : ['initialize', 'history', 'child_transcript'].includes(method)
            ? 'query'
            : 'effect_command',
      availability: available.has(method) ? 'available' : 'unsupported',
      reason: '',
    })),
    limits: { ...DEFAULT_LIMITS, ...limits },
    requirements: SDK_REQUIREMENTS,
  }
  const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url))
  const loader = fileURLToPath(new URL('./worker-test-loader.mjs', import.meta.url))
  const child = spawn(process.execPath, [...(fixture ? ['--experimental-loader', loader] : []), worker], {
    cwd,
    env: { ...env, ADE_CLAUDE_WORKER_DESCRIPTOR: JSON.stringify(descriptor) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames = []
  let stderr = '',
    sequence = 0,
    exit
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      resolve(exit)
    }),
  )
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  createInterface({ input: child.stdout }).on('line', (line) => frames.push(JSON.parse(line)))
  const events = () => frames.filter((frame) => frame.method === 'event').map((frame) => frame.params)
  const wait = async (predicate) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const found = predicate(events(), frames)
      if (found) return found
      if (exit) throw new Error('Worker exited: ' + JSON.stringify(exit) + ' ' + stderr)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Worker timed out: ' + stderr + ' frames=' + JSON.stringify(frames.slice(-20)))
  }
  const rpc = async (method, params) => {
    const id = ++sequence
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return wait((_, frames) => frames.find((frame) => frame.id === id))
  }
  return {
    child,
    events,
    wait,
    rpc,
    exited,
    diagnostics: () => stderr,
    initialize: () => rpc('initialize', { versions: [PROTOCOL_VERSION] }),
    open: (resume = null) =>
      rpc('open', { resume, config: { model: null, permission_mode: 'default', setting_sources: [] } }),
    send: (session, scenario, submission = scenario, message_id = 'ade-user-' + scenario) =>
      rpc('send', { session, source_attempt_id: 'attempt', submission, message_id, text: scenario, attachments: [] }),
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000)
      try {
        return await exited
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
