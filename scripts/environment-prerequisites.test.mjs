import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import systemPrerequisites from '../e2e/setup/system.ts'
import packagePrerequisites from '../e2e/setup/package.ts'

test('system setup checks builds before any disk fixture can run', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ade-system-prerequisites-'))
  const previous = process.env.ADE_E2E_SYSTEM
  try {
    process.env.ADE_E2E_SYSTEM = '1'
    assert.throws(
      () => systemPrerequisites({ rootDir: resolve(root, 'e2e/protocol'), metadata: {} }),
      /Backend acceptance prerequisite missing: target\/debug\/ade-daemon/,
    )
  } finally {
    if (previous === undefined) delete process.env.ADE_E2E_SYSTEM
    else process.env.ADE_E2E_SYSTEM = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'package setup refuses directories masquerading as packaged executables',
  { skip: process.platform !== 'darwin' },
  () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ade-package-prerequisites-'))
    const previous = process.env.ADE_E2E_PACKAGE_APP
    try {
      process.env.ADE_E2E_PACKAGE_APP = root
      for (const entry of [
        'Contents/MacOS/Lux ADE',
        'Contents/MacOS/ade',
        'Contents/MacOS/ade-control',
        'Contents/MacOS/ade-daemon',
        'Contents/MacOS/ade-runtime',
        'Contents/Resources/bin/ade-node',
        'Contents/Resources/bin/bun',
      ]) {
        const file = resolve(root, entry)
        mkdirSync(file, { recursive: true })
        assert.throws(
          () => packagePrerequisites(),
          (error) => error.message.includes(entry),
        )
        rmSync(file, { recursive: true })
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, '#!/bin/sh\nexit 97\n', { mode: 0o700 })
      }
      assert.throws(() => packagePrerequisites(), /missing candidate metadata/)
    } finally {
      if (previous === undefined) delete process.env.ADE_E2E_PACKAGE_APP
      else process.env.ADE_E2E_PACKAGE_APP = previous
      rmSync(root, { recursive: true, force: true })
    }
  },
)
