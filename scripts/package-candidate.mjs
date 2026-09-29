import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeJson } from './run-stages.mjs'

export const candidateExecutables = [
  'Contents/MacOS/Lux ADE',
  'Contents/MacOS/ade',
  'Contents/MacOS/ade-control',
  'Contents/MacOS/ade-daemon',
  'Contents/MacOS/ade-runtime',
  'Contents/Resources/bin/ade-node',
  'Contents/Resources/bin/bun',
]
const sha = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const validateMetadata = new Ajv({ strict: true }).compile({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'builtAt', 'target', 'revision', 'dirty', 'sourceSha256', 'artifact'],
  properties: {
    version: { const: 1 },
    builtAt: { type: 'string', minLength: 1 },
    target: { enum: ['darwin-arm64', 'darwin-x64'] },
    revision: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
    dirty: { type: 'boolean' },
    sourceSha256: sha,
    artifact: {
      type: 'object',
      additionalProperties: false,
      required: ['sha256', 'entries'],
      properties: { sha256: sha, entries: { type: 'integer', minimum: 1 } },
    },
  },
})

function hashFile(filename) {
  const hash = createHash('sha256')
  const fd = openSync(filename, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let size
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Content, permissions and internal link targets; no absolute build location enters the digest. */
export function artifactIdentity(app) {
  const root = realpathSync(app)
  const hash = createHash('sha256')
  let entries = 0
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const filename = join(directory, name)
      const info = lstatSync(filename)
      let content
      if (info.isSymbolicLink()) {
        const destination = realpathSync(filename)
        const suffix = relative(root, destination)
        if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
          throw new Error(`Candidate link escapes the application: ${relative(root, filename)}`)
        content = ['link', readlinkSync(filename)]
      } else if (info.isFile()) content = ['file', hashFile(filename)]
      else if (info.isDirectory()) content = ['directory']
      else throw new Error(`Unsupported candidate entry: ${relative(root, filename)}`)
      hash.update(JSON.stringify([relative(root, filename), info.mode & 0o777, ...content]) + '\n')
      entries++
      if (info.isDirectory()) walk(filename)
    }
  }
  walk(root)
  return { sha256: hash.digest('hex'), entries }
}

export function candidateSource(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const hash = createHash('sha256')
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  for (const filename of [...new Set(files)].sort()) {
    const absolute = resolve(root, filename)
    const info = existsSync(absolute) ? lstatSync(absolute) : null
    const content = info?.isSymbolicLink()
      ? ['link', readlinkSync(absolute)]
      : info?.isFile()
        ? ['file', info.mode & 0o777, hashFile(absolute)]
        : ['deleted']
    hash.update(JSON.stringify([filename, ...content]) + '\n')
  }
  return {
    revision: git(['rev-parse', 'HEAD']).trim(),
    dirty: git(['status', '--porcelain']).trim() !== '',
    sourceSha256: hash.digest('hex'),
  }
}

export function writeCandidateMetadata(app, source) {
  const metadata = {
    version: 1,
    builtAt: new Date().toISOString(),
    target: `${process.platform}-${process.arch}`,
    ...source,
    artifact: artifactIdentity(app),
  }
  if (!validateMetadata(metadata)) throw new Error('Invalid candidate build metadata')
  // Keep metadata beside the app so writing it cannot invalidate its signature.
  writeJson(`${resolve(app)}.candidate.json`, metadata)
  return metadata
}

export function verifyCandidate(app, expectedIdentity) {
  for (const entry of candidateExecutables) {
    try {
      accessSync(join(app, entry), constants.X_OK)
      if (!statSync(join(app, entry)).isFile()) throw new Error('Not a file')
    } catch {
      throw new Error(`Package prerequisite missing or not executable: ${entry}. Run pnpm package:mac.`)
    }
  }
  let metadata
  try {
    metadata = JSON.parse(readFileSync(`${resolve(app)}.candidate.json`, 'utf8'))
  } catch {
    throw new Error('Package prerequisite missing candidate metadata. Rebuild with pnpm package:mac.')
  }
  if (!validateMetadata(metadata) || !Number.isFinite(Date.parse(metadata.builtAt)))
    throw new Error('Package prerequisite invalid candidate metadata')
  if (metadata.target !== `${process.platform}-${process.arch}` || process.platform !== 'darwin')
    throw new Error(`Package prerequisite incompatible candidate target: ${metadata.target}`)
  // The builder produces thin native executables. Reject a metadata-only architecture claim.
  for (const entry of ['Lux ADE', 'ade-control', 'ade-daemon', 'ade-runtime']) {
    const fd = openSync(join(app, 'Contents/MacOS', entry), 'r')
    const header = Buffer.alloc(8)
    let size
    try {
      size = readSync(fd, header, 0, 8, 0)
    } finally {
      closeSync(fd)
    }
    const cpu = process.arch === 'arm64' ? 0x0100000c : 0x01000007
    if (size !== 8 || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu)
      throw new Error(`Package prerequisite incompatible native executable: ${entry}`)
  }
  const actual = artifactIdentity(app)
  if (actual.sha256 !== metadata.artifact.sha256 || actual.entries !== metadata.artifact.entries)
    throw new Error('Package prerequisite candidate contents differ from build metadata')
  if (expectedIdentity && expectedIdentity !== actual.sha256)
    throw new Error('Package prerequisite candidate changed during acceptance')
  return { app: resolve(app), ...metadata }
}
