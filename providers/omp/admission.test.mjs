import { test, expect } from 'bun:test'
import { promptPayload } from './admission.mjs'

test('attachments use native image blocks and UTF-8 text', () => {
  const payload = promptPayload({
    text: '',
    attachments: [
      { attachment: { name: 'a.png', media_type: 'image/png' }, data: 'YWJj' },
      { attachment: { name: 'notes.txt', media_type: 'text/plain' }, data: Buffer.from('你好').toString('base64') },
    ],
  })
  expect(payload.images).toEqual([{ type: 'image', mimeType: 'image/png', data: 'YWJj' }])
  expect(payload.message).toContain('你好')
})
