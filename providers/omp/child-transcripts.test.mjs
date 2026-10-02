import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChildTranscript } from './child-transcripts.mjs'

test('child reader follows ancestry, hides private thinking and rejects a replacement file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-child-reader-'))
  const filename = join(directory, 'child.jsonl')
  try {
    const records = [
      { type: 'session', id: 'native-child', version: 3, cwd: directory, timestamp: new Date().toISOString() },
      { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'Task' } },
      {
        type: 'message',
        id: 'abandoned',
        parentId: 'user',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ABANDONED' }] },
      },
      {
        type: 'message',
        id: 'answer',
        parentId: 'user',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'PRIVATE' },
            { type: 'text', text: 'Current answer' },
          ],
          stopReason: 'stop',
        },
      },
    ]
    await writeFile(filename, records.map((x) => JSON.stringify(x)).join('\n') + '\n{"partial":')
    const first = await readChildTranscript(filename, 'child', 0)
    expect(first.header_id).toBe('native-child')
    expect(first.page.items.map((i) => i.text)).toEqual(['Task', 'Current answer'])
    expect(JSON.stringify(first)).not.toContain('PRIVATE')
    expect(await readChildTranscript(filename, 'child', 0, first.header_id)).toEqual(first)
    records[0].id = 'replacement'
    await writeFile(filename, records.map((x) => JSON.stringify(x)).join('\n') + '\n')
    await expect(readChildTranscript(filename, 'child', 0, first.header_id)).rejects.toThrow('identity changed')
    await expect(readChildTranscript('relative.jsonl', 'child', 0)).rejects.toThrow('identity')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
