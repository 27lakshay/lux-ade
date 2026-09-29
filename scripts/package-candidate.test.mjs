import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  artifactIdentity,
  candidateExecutables,
  verifyCandidate,
  writeCandidateMetadata,
} from './package-candidate.mjs'
import { candidateOptions } from './test-candidate.mjs'

test('candidate command requires an explicit artifact and rejects runner/retry overrides', () => {
  assert.throws(() => candidateOptions([]), /existing candidate/)
  assert.throws(() => candidateOptions(['--app', '/candidate', '--retries', '1']), /Unknown/)
  assert.throws(() => candidateOptions(['--app', '/candidate', '--project', 'unknown']), /Unknown/)
  assert.deepEqual(candidateOptions(['--app', '/candidate', '--project', 'package-protocol']).projects, [
    'package-protocol',
  ])
})

test('candidate content identity includes modes, files and internal links and refuses external links', () => {
  const root = mkdtempSync(join(tmpdir(), 'ade-candidate-hash-'))
  try {
    const file = join(root, 'binary')
    writeFileSync(file, 'one', { mode: 0o700 })
    const first = artifactIdentity(root)
    chmodSync(file, 0o600)
    assert.notEqual(artifactIdentity(root).sha256, first.sha256)
    chmodSync(file, 0o700)
    assert.deepEqual(artifactIdentity(root), first)
    writeFileSync(file, 'two')
    assert.notEqual(artifactIdentity(root).sha256, first.sha256)
    symlinkSync('binary', join(root, 'alias'))
    assert.equal(artifactIdentity(root).entries, 2)
    symlinkSync('/bin/sh', join(root, 'escape'))
    assert.throws(() => artifactIdentity(root), /escapes/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'candidate prerequisites refuse missing identity, wrong target, invalid metadata and mutated artifacts',
  {
    skip: process.platform !== 'darwin',
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'ade-candidate-verify-'))
    const app = join(root, 'Lux ADE.app')
    try {
      for (const entry of candidateExecutables) {
        const filename = join(app, entry)
        mkdirSync(dirname(filename), { recursive: true })
        const header = Buffer.alloc(8)
        header.writeUInt32LE(0xfeedfacf, 0)
        header.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
        writeFileSync(filename, header, { mode: 0o700 })
      }
      assert.throws(() => verifyCandidate(app), /missing candidate metadata/)
      const metadata = writeCandidateMetadata(app, {
        revision: 'a'.repeat(40),
        dirty: true,
        sourceSha256: 'b'.repeat(64),
      })
      assert.equal(verifyCandidate(app).artifact.sha256, metadata.artifact.sha256)
      assert.throws(() => verifyCandidate(app, 'c'.repeat(64)), /changed during acceptance/)
      const sidecar = `${app}.candidate.json`
      writeFileSync(
        sidecar,
        JSON.stringify({ ...metadata, target: process.arch === 'arm64' ? 'darwin-x64' : 'darwin-arm64' }),
      )
      assert.throws(() => verifyCandidate(app), /incompatible candidate target/)
      writeFileSync(sidecar, JSON.stringify({ ...metadata, revision: null }))
      assert.throws(() => verifyCandidate(app), /invalid candidate metadata/)
      writeFileSync(sidecar, JSON.stringify(metadata))
      writeFileSync(join(app, 'Contents/Resources/changed'), 'changed')
      assert.throws(() => verifyCandidate(app), /contents differ/)
      rmSync(join(app, 'Contents/Resources/changed'))
      writeFileSync(join(app, 'Contents/MacOS/ade-daemon'), '#!/bin/sh\n')
      assert.throws(() => verifyCandidate(app), /incompatible native executable/)
      assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).revision, metadata.revision)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
