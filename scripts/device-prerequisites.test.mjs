import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { deviceRuntimePrerequisites } from '../e2e/setup/devices.ts'
import { backendBuildPrerequisites } from '../e2e/setup/backend-build.ts'

test('device acceptance refuses incomplete builds before fixture launch', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ade-device-build-'))
  try {
    for (const entry of [
      'target/debug/ade-daemon',
      'target/debug/ade-runtime',
      'apps/cli/dist/index.js',
      'packages/client/dist/index.js',
    ]) {
      assert.throws(() => backendBuildPrerequisites(directory), /Backend acceptance prerequisite missing/)
      const file = resolve(directory, entry)
      mkdirSync(dirname(file), { recursive: true })
      mkdirSync(file)
      assert.throws(
        () => backendBuildPrerequisites(directory),
        (error) => error.message.includes(entry),
      )
      rmSync(file, { recursive: true })
      writeFileSync(file, '', { mode: 0o700 })
    }
    assert.doesNotThrow(() => backendBuildPrerequisites(directory))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('device fixtures reject missing and incompatible Python before execution', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ade-device-python-'))
  try {
    assert.throws(() => deviceRuntimePrerequisites({ PATH: directory }), /requires a runnable Python 3/)
    writeFileSync(resolve(directory, 'python3'), '#!/bin/sh\necho "Python 2.7.18"\n', { mode: 0o700 })
    assert.throws(() => deviceRuntimePrerequisites({ PATH: directory }), /requires a runnable Python 3/)
    assert.doesNotThrow(() => deviceRuntimePrerequisites(process.env))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
