/// <reference types="vite/client" />
import type { Layout, LayoutAction } from '@ade/contracts'
import { expect, test } from 'vitest'
import { applyLayout } from './reducer'

// Lane A's shared vectors (`crates/ade-core/tests/layout-vectors`), which the daemon's Rust core
// also runs: the double gives the daemon's result for every one, or it would drift.

interface Vector {
  name: string
  before: Layout
  action: LayoutAction
  after: Layout
}

const files = import.meta.glob<Vector[]>('../../../../../../../crates/ade-core/tests/layout-vectors/*.json', {
  eager: true,
  import: 'default',
})

/** Equal as JSON, with numbers equal to within rounding of the last bit, as the Rust test compares. */
function same(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number')
    return Math.abs(left - right) <= 1e-9 * Math.max(Math.abs(left), 1)
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => same(item, right[index]))
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const a = Object.entries(left)
    return a.length === Object.keys(right).length && a.every(([key, value]) => same(value, (right as never)[key]))
  }
  return left === right
}

test('the layout double gives the daemon result for every shared vector', () => {
  let count = 0
  expect(Object.keys(files).length).toBeGreaterThanOrEqual(5)
  for (const [file, vectors] of Object.entries(files)) {
    for (const vector of vectors) {
      const after = applyLayout(vector.before, vector.action)
      if (!same(after, vector.after)) expect(after, `${file.split('/').at(-1)}: ${vector.name}`).toEqual(vector.after)
      count++
    }
  }
  expect(count).toBeGreaterThan(100)
})
