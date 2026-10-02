// Session storage for the deterministic Claude Agent SDK double (worker-test-sdk.mjs).
// Never imports Claude or calls a model.
//
// Transcripts are JSON lines, one native entry per line. Under a CLAUDE_CONFIG_DIR (a
// managed account) they live where Claude Code keeps them,
// <config>/projects/<cwd with non-alphanumerics as ->/<session>.jsonl, so each account
// home holds its own sessions, and the call log and release files live in
// <config>/ade-mock. Otherwise both live in ADE_CLAUDE_WORKER_TEST_DIR. Without either,
// sessions stay in memory, seeded from CLAUDE_WORKER_HISTORY (`<session>` and
// `<session>/<child>` keys), which worker unit tests use.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const config = process.env.CLAUDE_CONFIG_DIR
export const directory = config ? join(config, 'ade-mock') : process.env.ADE_CLAUDE_WORKER_TEST_DIR
const memory = new Map(Object.entries(JSON.parse(process.env.CLAUDE_WORKER_HISTORY ?? '{}')))
const onDisk = !!directory && !process.env.CLAUDE_WORKER_HISTORY
// The child transcript the `typed-subagents` scenario writes into its session file.
export const fixtureChild = { task: 'fixture-child', tool: 'fixture-spawn' }

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const released = (name) => !!directory && existsSync(join(directory, name))
export function record(value) {
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  appendFileSync(join(directory, 'calls.jsonl'), JSON.stringify({ pid: process.pid, ...value }) + '\n')
}

/** The text a user entry was prompted with, whether stored as a string or as native content blocks. */
export function promptText(entry) {
  if (entry?.type !== 'user' || entry.parent_tool_use_id) return null
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || !content.some((block) => ['text', 'image', 'document'].includes(block.type)))
    return null
  return content.find((block) => block.type === 'text')?.text ?? ''
}

const project = (cwd) =>
  config ? join(config, 'projects', String(cwd ?? process.cwd()).replace(/[^a-zA-Z0-9]/g, '-')) : directory
function locate(id) {
  if (!config) return join(directory, `${id}.jsonl`)
  const projects = join(config, 'projects')
  const found = existsSync(projects)
    ? readdirSync(projects)
        .map((name) => join(projects, name, `${id}.jsonl`))
        .find((path) => existsSync(path))
    : null
  return found ?? join(project(), `${id}.jsonl`)
}
function write(path, entries) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry) + '\n').join(''))
}

/** Every entry of a session, or undefined when the session does not exist. */
export function load(id) {
  if (!onDisk) return memory.get(id)
  const path = locate(id)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/**
 * Where a query's session is saved. A fresh or forked session goes beside its source (or in
 * the cwd's project), a resumed one stays where it is.
 */
export function writer(session, { source = null, fork = false, cwd } = {}) {
  if (!onDisk) return (entries) => memory.set(session, entries)
  const path =
    fork || !source ? join(source ? dirname(locate(source)) : project(cwd), `${session}.jsonl`) : locate(session)
  return (entries) => write(path, entries)
}

export async function getSessionInfo(sessionId) {
  if (!onDisk) {
    const entries = memory.get(sessionId)
    return entries ? { sessionId, lastModified: 37, fileSize: Buffer.byteLength(JSON.stringify(entries)) } : undefined
  }
  const path = locate(sessionId)
  if (!existsSync(path)) return undefined
  const stat = statSync(path)
  return { sessionId, lastModified: stat.mtimeMs, fileSize: stat.size }
}
export async function getSessionMessages(session, { offset = 0, limit = 32 } = {}) {
  return (load(session) ?? [])
    .slice(offset, offset + limit)
    .map(({ tool_use_result, ...entry }) => ({ parent_tool_use_id: null, session_id: session, ...entry }))
}
export async function listSubagents(session) {
  if (!onDisk)
    return [...memory.keys()].filter((id) => id.startsWith(session + '/')).map((id) => id.slice(session.length + 1))
  return (load(session) ?? []).some((entry) => entry.parent_tool_use_id === fixtureChild.tool)
    ? [fixtureChild.task]
    : []
}
export async function getSubagentMessages(session, child, { offset = 0, limit = 32 } = {}) {
  if (!onDisk) return getSessionMessages(session + '/' + child, { offset, limit })
  return (load(session) ?? [])
    .filter((entry) => child === fixtureChild.task && entry.parent_tool_use_id === fixtureChild.tool)
    .slice(offset, offset + limit)
}
// sdk.d.ts 0.3.281 documents forkSession(): it copies the transcript up to and including
// upToMessageId into a new session, remapping every message UUID and preserving the
// chain, and the fork is resumable with `resume`. The source is unchanged.
export async function forkSession(id, { upToMessageId } = {}) {
  const source = load(id)
  if (!source) throw new Error(`Session ${id} does not exist`)
  const at = upToMessageId === undefined ? source.length - 1 : source.findIndex((m) => m.uuid === upToMessageId)
  if (at < 0) throw new Error(`Message ${upToMessageId} is not in session ${id}`)
  const forked = randomUUID()
  // A session with a 'hold-fork' prompt forks only once the test creates 'release-fork'.
  if (source.some((entry) => promptText(entry) === 'hold-fork')) {
    record({ method: 'forkSession.held', session: id })
    while (!released('release-fork')) await sleep(20)
  }
  writer(forked, { source: id, fork: true })(
    source.slice(0, at + 1).map((entry) => ({ ...entry, uuid: randomUUID(), session_id: forked })),
  )
  record({ method: 'forkSession', session: id, upToMessageId: upToMessageId ?? null, forked })
  return { sessionId: forked }
}
export async function deleteSession(id) {
  if (onDisk) rmSync(locate(id), { force: true })
  else memory.delete(id)
  record({ method: 'deleteSession', session: id })
}
