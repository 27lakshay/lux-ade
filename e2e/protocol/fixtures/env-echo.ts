// Programs that report the environment ADE gave them, so a spec can prove
// what a service or script run actually received: its workspace and host
// identity, and secret values that replies redact. Nothing here sleeps.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * An HTTP server on `$PORT` (or the variable `E2E_PORT_VAR` names). Every
 * reply is JSON: `{ pid, port, env }`, where `env` holds every `ADE_*`
 * variable and each variable named in the comma-separated `E2E_ECHO`.
 * A gate file in `E2E_GATE` delays the bind until it exists.
 */
const serverSource = String.raw`import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
const port = Number(process.env[process.env.E2E_PORT_VAR || 'PORT'])
const echoed = (process.env.E2E_ECHO || '').split(',').filter(Boolean)
function env() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith('ADE_') || echoed.includes(key)))
}
const server = createServer((request, response) => {
  const body = JSON.stringify({ pid: process.pid, port: server.address().port, env: env() })
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
})
function listen() { server.listen(port, '127.0.0.1', () => console.log('listening on ' + port)) }
const gate = process.env.E2E_GATE
if (gate) {
  console.log('waiting for gate')
  const timer = setInterval(() => { if (existsSync(gate)) { clearInterval(timer); listen() } }, 25)
} else listen()
`

/** A one-shot program that prints `ENV <json>` with its `ADE_*` variables and exits. */
const printSource = String.raw`const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ADE_')))
console.log('ENV ' + JSON.stringify(env))
`

export type EnvEchoFiles = { server: string; print: string }

/** Write both programs into `directory` (normally a workspace root). */
export async function writeEnvEchoPrograms(directory: string): Promise<EnvEchoFiles> {
  const folder = join(directory, 'e2e-env-echo')
  await mkdir(folder, { recursive: true })
  const files = { server: join(folder, 'server.mjs'), print: join(folder, 'print.mjs') }
  await writeFile(files.server, serverSource)
  await writeFile(files.print, printSource)
  return files
}

/** The `ENV` line a print run wrote, parsed; `undefined` until it appears. */
export function printedEnv(output: string): Record<string, string> | undefined {
  const line = /ENV (\{.*\})/.exec(output)
  return line ? (JSON.parse(line[1]) as Record<string, string>) : undefined
}
