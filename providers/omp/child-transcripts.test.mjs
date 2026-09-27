import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChildTranscripts } from './child-transcripts.mjs'

test('child reference survives restart; reader follows ancestry and rejects unrelated parents and replacement files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-child-reader-'))
  const filename = join(directory, 'child.jsonl'),
    database = join(directory, 'references.sqlite')
  let db = new Database(database)
  try {
    let reader = new ChildTranscripts(db)
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
    reader.remember('parent', { id: 'child', sessionFile: filename })
    const first = await reader.read('parent', 'child', 0)
    expect(first.items.map((i) => i.text)).toEqual(['Task', 'Current answer'])
    expect(JSON.stringify(first)).not.toContain('PRIVATE')
    db.close()
    db = new Database(database)
    reader = new ChildTranscripts(db)
    expect(await reader.read('parent', 'child', 0)).toEqual(first)
    await expect(reader.read('other', 'child', 0)).rejects.toThrow('not announced')
    expect(() => reader.remember('parent', { id: 'child', sessionFile: filename + '.other' })).toThrow('path changed')
    records[0].id = 'replacement'
    await writeFile(filename, records.map((x) => JSON.stringify(x)).join('\n') + '\n')
    await expect(reader.read('parent', 'child', 0)).rejects.toThrow('identity changed')
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
