// A forge that serves Git's smart HTTP protocol with Basic authentication, and
// a Git credential helper that answers for it. Both stay on this machine:
// the server listens on 127.0.0.1 and runs `git http-backend` over bare
// repositories under its root. Git reaches it through the forge's HTTPS URL
// by `url.<base>.insteadOf`, so ADE keeps the URL a person would paste.
//
// The server speaks plain HTTP. Git's TLS on macOS goes through the Security
// framework, which E2E must never call (AGENTS.md, machine safety).
//
// `safeHelpers` is the gate every spec here runs before any network step: it
// reads, without running any helper, the credential helpers the daemon's Git
// would use, and fails unless the scratch helper is the only one.
import { execFile, spawn } from 'node:child_process'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ScratchProfile } from '../fixtures'

const execFileAsync = promisify(execFile)

export type ForgeRequest = { method: string; path: string; service: string | null; user: string | null; status: number }

export class HttpForge {
  /** Accepted Basic credentials; change them to rotate a token. */
  credentials: { user: string; password: string }
  readonly requests: ForgeRequest[] = []
  private constructor(
    readonly root: string,
    readonly port: number,
    private readonly env: Record<string, string>,
    private readonly close: () => Promise<void>,
    credentials: { user: string; password: string },
  ) {
    this.credentials = credentials
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}/`
  }

  stop(): Promise<void> {
    return this.close()
  }

  /** Serve bare repositories under `root` to requests carrying `credentials`. */
  static async start(
    root: string,
    env: Record<string, string>,
    credentials: { user: string; password: string },
  ): Promise<HttpForge> {
    let forge: HttpForge | undefined
    const server = createServer((request, response) => {
      void forge!.handle(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500)
        response.end(String(error))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    forge = new HttpForge(root, port, env, close, credentials)
    return forge
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://forge.invalid')
    const service = url.searchParams.get('service') ?? url.pathname.match(/\/(git-[a-z-]+)$/)?.[1] ?? null
    const header = request.headers.authorization ?? ''
    const decoded = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : ''
    const user = decoded.includes(':') ? decoded.slice(0, decoded.indexOf(':')) : null
    const accepted = decoded === `${this.credentials.user}:${this.credentials.password}`
    const record = { method: request.method ?? 'GET', path: url.pathname, service, user: accepted ? user : null }
    if (!accepted) {
      this.requests.push({ ...record, status: 401 })
      request.resume()
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="forge"', 'Content-Type': 'text/plain' })
      response.end('Authentication required\n')
      return
    }
    const child = spawn('git', ['http-backend'], {
      env: {
        ...this.env,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method ?? 'GET',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        REMOTE_USER: user ?? '',
        REMOTE_ADDR: '127.0.0.1',
        ...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}),
        ...(request.headers['content-encoding']
          ? { HTTP_CONTENT_ENCODING: String(request.headers['content-encoding']) }
          : {}),
        ...(request.headers['git-protocol'] ? { GIT_PROTOCOL: String(request.headers['git-protocol']) } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    request.pipe(child.stdin)
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    const output = Buffer.concat(chunks)
    const split = output.indexOf('\r\n\r\n') >= 0 ? output.indexOf('\r\n\r\n') : output.indexOf('\n\n')
    const gap = output.indexOf('\r\n\r\n') >= 0 ? 4 : 2
    const headers: Record<string, string> = {}
    let status = code === 0 ? 200 : 500
    for (const line of output.subarray(0, Math.max(split, 0)).toString('latin1').split(/\r?\n/)) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const name = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
      else headers[name] = value
    }
    this.requests.push({ ...record, status })
    response.writeHead(status, headers)
    response.end(split >= 0 ? output.subarray(split + gap) : output)
  }
}

export type CredentialHelper = {
  path: string
  /** Each call as Git made it: the action and the fields it sent, without any password. */
  calls(): Promise<Array<{ action: string; protocol?: string; host?: string; username?: string }>>
}

/** A credential helper that answers `get` with the credentials in `secretFile`. */
export async function credentialHelper(dir: string, secretFile: string): Promise<CredentialHelper> {
  const path = join(dir, 'forge-credentials.mjs')
  const log = join(dir, 'credential-calls.jsonl')
  await writeFile(
    path,
    `#!/usr/bin/env node
// Scratch Git credential helper for E2E. See e2e/protocol/files2/git-http.ts.
import { appendFileSync, readFileSync } from 'node:fs'
const action = process.argv[2] ?? ''
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const fields = Object.fromEntries(input.split('\\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ action, protocol: fields.protocol, host: fields.host,
    username: fields.username }) + '\\n')
  if (action === 'get') {
    const { user, password } = JSON.parse(readFileSync(${JSON.stringify(secretFile)}, 'utf8'))
    process.stdout.write('username=' + user + '\\npassword=' + password + '\\n')
  }
})
`,
  )
  await chmod(path, 0o755)
  return {
    path,
    async calls() {
      const text = await readFile(log, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
  }
}

/**
 * The credential helpers the daemon's Git would run in `cwd`, in order, after
 * Git's resets. The daemon's Git sees no `GIT_CONFIG_*` variables, so neither
 * does this read. It runs `git config` only; no helper runs.
 */
export async function effectiveHelpers(profile: ScratchProfile, cwd: string): Promise<string[]> {
  const env = Object.fromEntries(Object.entries(profile.env).filter(([name]) => !name.startsWith('GIT_CONFIG_')))
  const { stdout } = await execFileAsync('git', ['config', '--show-origin', '--get-all', 'credential.helper'], {
    cwd,
    env,
  }).catch((error: { code?: number; stdout?: string }) => {
    if (error.code === 1) return { stdout: '' }
    throw error
  })
  const values = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf('\t') + 1))
  const reset = values.lastIndexOf('')
  return values.slice(reset + 1)
}
