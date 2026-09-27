// Native provider session files written into a scratch profile's HOME, in the
// on-disk layouts Claude Code and Codex use, for import and history specs.
// The records are trimmed to what the importers read; no provider wrote them.
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type NativeSession = {
  /** The session's UUID, which the file name carries. */
  id: string
  /** The file the session lives in. */
  path: string
  /** Append whole records; `partial` leaves the last one without its newline. */
  append(records: Array<Record<string, unknown>>, options?: { partial?: boolean }): Promise<void>
  /** Replace the file's content, as a provider that rewrote its history would. */
  rewrite(records: Array<Record<string, unknown>>): Promise<void>
}

const jsonl = (records: Array<Record<string, unknown>>) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('')

function session(id: string, path: string): NativeSession {
  return {
    id,
    path,
    async append(records, options = {}) {
      const text = jsonl(records)
      await appendFile(path, options.partial ? text.replace(/\n$/, '') : text)
    },
    async rewrite(records) {
      await writeFile(path, jsonl(records))
    },
  }
}

/** A Claude Code transcript at `<home>/.claude/projects/<project>/<id>.jsonl`. */
export async function claudeTranscript(
  home: string,
  id: string,
  cwd: string,
  records: Array<Record<string, unknown>>,
): Promise<NativeSession> {
  const directory = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${id}.jsonl`)
  await writeFile(path, jsonl(records))
  return session(id, path)
}

/** Claude Code transcript records for one session: a chain of user and assistant text turns. */
export function claudeRecords(
  id: string,
  cwd: string,
  turns: Array<{ uuid: string; parent: string | null; role: 'user' | 'assistant'; text: string }>,
): Array<Record<string, unknown>> {
  return turns.map((turn, index) => ({
    type: turn.role,
    uuid: turn.uuid,
    parentUuid: turn.parent,
    isSidechain: false,
    sessionId: id,
    cwd,
    timestamp: new Date(Date.UTC(2026, 8, 1, 10, 0, index)).toISOString(),
    message:
      turn.role === 'user'
        ? { role: 'user', content: turn.text }
        : { role: 'assistant', content: [{ type: 'text', text: turn.text }] },
  }))
}

/** A Codex rollout at `<home>/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. */
export async function codexRollout(
  home: string,
  id: string,
  cwd: string,
  records: Array<Record<string, unknown>>,
): Promise<NativeSession> {
  const directory = join(home, '.codex', 'sessions', '2026', '09', '06')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `rollout-2026-09-06T13-36-02-${id}.jsonl`)
  await writeFile(
    path,
    jsonl([{ timestamp: '2026-09-06T13:36:02.049Z', type: 'session_meta', payload: { id, cwd } }, ...records]),
  )
  return session(id, path)
}

/** One Codex `response_item` message record. */
export function codexMessage(role: 'user' | 'assistant', text: string, second = 3): Record<string, unknown> {
  return {
    timestamp: `2026-09-06T13:36:${String(second).padStart(2, '0')}.000Z`,
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
  }
}
