import { describe, expect, test } from 'vitest'
import { whenHolds } from './when'

describe('when clauses', () => {
  const context = { inputFocus: false, focus: 'terminal', panes: 2, sidebar: true }

  test.each([
    [undefined, true],
    ['', true],
    ['sidebar', true],
    ['inputFocus', false],
    ['!inputFocus', true],
    ["focus == 'terminal'", true],
    ["focus != 'terminal'", false],
    ['panes == 2', true],
    ["sidebar && focus == 'terminal'", true],
    ["inputFocus || focus == 'chat'", false],
    ["!(inputFocus || focus == 'chat') && sidebar", true],
    ['missing', false],
  ])('%s → %s', (clause, expected) => {
    expect(whenHolds(clause, context)).toBe(expected)
  })

  test('rejects invalid syntax', () => {
    expect(() => whenHolds('a &&', context)).toThrow()
    expect(() => whenHolds('(a', context)).toThrow()
    expect(() => whenHolds('a b', context)).toThrow()
  })
})
