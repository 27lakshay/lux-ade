// Native sessions use isolated data. Transcript seeds call only the loopback fixture.
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
const provider = process.argv[2]
const title = 'lux-ade-NATIVE-TRANSFER-CHECK'
if (provider === 'omp') {
  const { SessionManager } = await import('./omp/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts')
  const directory = join(process.env.ADE_DATA_DIR, 'omp/sessions')
  await mkdir(directory, { recursive: true })
  const manager = SessionManager.create(process.cwd(), directory)
  try {
    await manager.ensureOnDisk()
    await manager.setSessionName(title, 'user')
    console.log(
      JSON.stringify({
        session: JSON.stringify({ v: 1, id: manager.getSessionId(), file: await realpath(manager.getSessionFile()) }),
        title,
      }),
    )
  } finally {
    await manager.close()
  }
} else if (provider === 'opencode') {
  const { OpenCodeTransport } = await import('./opencode/transport.mjs')
  const server = await OpenCodeTransport.start()
  try {
    const session = (await server.request('POST', '/api/session', { title, location: { directory: process.cwd() } }))
      .data
    console.log(JSON.stringify({ session: session.id, title }))
  } finally {
    await server.stop()
  }
} else if (provider === 'codex') {
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const child = spawn(process.env.ADE_CODEX_BIN, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  let next = 0
  const pending = new Map()
  const completed = new Set()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const value = JSON.parse(line)
    if (value.method === 'turn/completed' && value.params.turn.status === 'completed')
      completed.add(value.params.threadId)
    const reply = pending.get(value.id)
    if (!reply) return
    pending.delete(value.id)
    if (value.error) reply.reject(new Error(JSON.stringify(value.error)))
    else reply.resolve(value.result)
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 10000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  try {
    await request('initialize', { clientInfo: { name: 'ade-native-test', version: '1' } })
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    const opened = await request('thread/start', {
      cwd: process.cwd(),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    if (opened.modelProvider !== 'native-test') throw new Error('Native test provider configuration was not applied')
    await request('turn/start', {
      threadId: opened.thread.id,
      input: [{ type: 'text', text: 'Local protocol fixture. Return the predetermined reply without tools.' }],
    })
    let complete = false
    for (let i = 0; i < 100; i++) {
      if (completed.has(opened.thread.id)) {
        complete = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!complete) throw new Error('Local fixture turn did not finish')
    await request('thread/name/set', { threadId: opened.thread.id, name: title })
    console.log(JSON.stringify({ session: opened.thread.id, title }))
  } finally {
    lines.close()
    child.stdin.end()
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
} else if (provider === 'claude') {
  const { Bridge } = await import('./claude/bridge.mjs')
  const sdk = await import('./claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')
  const { randomUUID } = await import('node:crypto')
  let finished
  const bridge = new Bridge(sdk, (frame) => {
    if (frame.params?.type === 'finished') finished = frame.params
  })
  try {
    const opened = await bridge.open({ config: { model: 'claude-sonnet-4-6', setting_sources: [] } })
    bridge.send({
      session: opened.session,
      submission: randomUUID(),
      message_id: randomUUID(),
      text: 'Local protocol fixture. Return the predetermined reply without tools.',
    })
    for (let i = 0; !finished && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    if (finished?.status !== 'completed')
      throw new Error(`Local Claude fixture did not finish: ${JSON.stringify(finished)}`)
    console.log(JSON.stringify({ session: opened.session, title }))
  } finally {
    bridge.close()
  }
} else throw new Error('Unknown native fixture provider')
