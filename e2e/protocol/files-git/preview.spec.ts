// F073: previews of text, images and large files, their limits, unsupported
// formats, and active content that never reaches the client as renderable.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { openWorkspace } from './steps'

const LIMIT = 256 * 1024
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1), Buffer.from([0xff, 0xd9])])
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.alloc(14, 0)])

test('previews text and the supported image formats with their MIME type and size', async ({ ade, profile }) => {
  const root = join(ade.root, 'media')
  await mkdir(join(root, 'img'), { recursive: true })
  const files: Record<string, Buffer | string> = {
    'notes.md': '# Notes\n\nUnicode: é中😀\n',
    'src/main.ts': 'export const answer = 42\n',
    'empty.txt': '',
    'img/pixel.png': png, 'img/photo.JPG': jpeg, 'img/photo.jpeg': jpeg, 'img/anim.gif': gif, 'img/modern.webp': webp,
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const workspace_id = await openWorkspace(profile, root)
  const preview = (path: string) => profile.call('file.preview', { workspace_id, path })

  expect(await preview('notes.md')).toEqual({ type: 'file_preview', path: 'notes.md', kind: 'text', mime: 'text/plain',
    text: files['notes.md'], size: Buffer.byteLength(files['notes.md'] as string), truncated: false })
  expect(await preview('src/main.ts')).toMatchObject({ kind: 'text', text: 'export const answer = 42\n', truncated: false })
  expect(await preview('empty.txt')).toMatchObject({ kind: 'text', text: '', size: 0, truncated: false })

  const images: Array<[string, string, Buffer]> = [['img/pixel.png', 'image/png', png], ['img/photo.JPG', 'image/jpeg', jpeg],
    ['img/photo.jpeg', 'image/jpeg', jpeg], ['img/anim.gif', 'image/gif', gif], ['img/modern.webp', 'image/webp', webp]]
  for (const [path, mime, bytes] of images) {
    const image = await preview(path)
    expect(image, path).toMatchObject({ kind: 'image', mime, size: bytes.length, truncated: false })
    expect(Buffer.from(image.bytes_base64!, 'base64').equals(bytes), path).toBe(true)
    expect(image.text).toBeUndefined()
  }

  // The CLI shows the same preview.
  const cli = await profile.cli('file', 'preview', workspace_id, 'img/pixel.png')
  expect(cli.code).toBe(0)
  expect(cli.json).toMatchObject({ kind: 'image', mime: 'image/png', bytes_base64: png.toString('base64') })
})

test('large, binary, mislabelled and unsupported files show their limit or kind without content', async ({ ade, profile }) => {
  const root = join(ade.root, 'limits')
  await mkdir(root, { recursive: true })
  const big = `${'a'.repeat(LIMIT - 1)}étail that is never shown`
  await writeFile(join(root, 'big.log'), big)
  await writeFile(join(root, 'exact.txt'), 'b'.repeat(LIMIT))
  await writeFile(join(root, 'huge.png'), Buffer.concat([png, Buffer.alloc(LIMIT)]))
  await writeFile(join(root, 'fake.png'), 'this is not a PNG')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]))
  await writeFile(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  await writeFile(join(root, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))
  const workspace_id = await openWorkspace(profile, root)
  const preview = (path: string) => profile.call('file.preview', { workspace_id, path })

  // Oversized text is cut at the limit on a character boundary and flagged.
  const cut = await preview('big.log')
  expect(cut).toMatchObject({ kind: 'text', truncated: true, size: Buffer.byteLength(big) })
  expect(cut.text!.length).toBe(LIMIT - 1)
  expect(cut.text).not.toContain('tail')
  expect(JSON.stringify(cut).length).toBeLessThan(LIMIT + 1024)
  expect(await preview('exact.txt')).toMatchObject({ kind: 'text', truncated: false, size: LIMIT })

  // An image is shown only whole and only when its bytes match its type.
  const huge = await preview('huge.png')
  expect(huge).toEqual({ type: 'file_preview', path: 'huge.png', kind: 'unsupported', size: png.length + LIMIT, truncated: true })
  expect(await preview('fake.png')).toEqual({ type: 'file_preview', path: 'fake.png', kind: 'unsupported', size: 17, truncated: false })

  // Binary and non-UTF-8 content is unsupported, never shown as text.
  for (const path of ['binary.dat', 'latin1.txt', 'archive.zip']) {
    const result = await preview(path)
    expect(result, path).toMatchObject({ kind: 'unsupported', truncated: false })
    expect(result.text, path).toBeUndefined()
    expect(result.bytes_base64, path).toBeUndefined()
  }

  // Folders and missing files are refused rather than previewed.
  await mkdir(join(root, 'folder'))
  await expect(preview('folder')).rejects.toThrow()
  await expect(preview('missing.txt')).rejects.toThrow(/No such file/)
  await expect(preview('')).rejects.toThrow()
})

test('active content is never returned in a renderable form', async ({ ade, profile }) => {
  const root = join(ade.root, 'active')
  await mkdir(root, { recursive: true })
  const payload = '<script>window.ade.bridge.run("rm -rf ~")</script>'
  const active: Record<string, string> = {
    'page.html': `<!doctype html>${payload}`,
    'PAGE.HTM': payload,
    'doc.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml">${payload}</html>`,
    'icon.svg': `<svg xmlns="http://www.w3.org/2000/svg" onload="window.ade.bridge.run()">${payload}</svg>`,
    'feed.xml': `<?xml version="1.0"?><x>${payload}</x>`,
  }
  for (const [path, content] of Object.entries(active)) await writeFile(join(root, path), content)
  // HTML hiding behind a text extension is text, labelled text/plain.
  await writeFile(join(root, 'looks-like.txt'), payload)
  const workspace_id = await openWorkspace(profile, root)

  for (const path of Object.keys(active)) {
    const result = await profile.call('file.preview', { workspace_id, path })
    expect(result, path).toEqual({ type: 'file_preview', path, kind: 'unsupported',
      size: Buffer.byteLength(active[path]), truncated: false })
    expect(JSON.stringify(result), path).not.toContain('bridge')
  }
  const text = await profile.call('file.preview', { workspace_id, path: 'looks-like.txt' })
  expect(text).toMatchObject({ kind: 'text', mime: 'text/plain', text: payload })
  // No preview reply ever carries an HTML, SVG or script MIME type.
  expect(text.mime).toBe('text/plain')
})
