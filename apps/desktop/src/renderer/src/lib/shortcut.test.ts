import { expect, test } from 'vitest'
import { formatShortcut } from './shortcut'

test('menu accelerators read as macOS writes them', () => {
  expect(formatShortcut('CmdOrCtrl+Shift+P', true)).toEqual(['⌘⇧P'])
  expect(formatShortcut('CmdOrCtrl+Alt+B', true)).toEqual(['⌘⌥B'])
  expect(formatShortcut('CmdOrCtrl+\\', true)).toEqual(['⌘\\'])
  expect(formatShortcut('CmdOrCtrl+,', true)).toEqual(['⌘,'])
})

test('command-service chords read as one key group per step', () => {
  expect(formatShortcut('$mod+K $mod+T', true)).toEqual(['⌘K', '⌘T'])
  expect(formatShortcut('$mod+KeyS', true)).toEqual(['⌘S'])
  expect(formatShortcut('Shift+Enter', true)).toEqual(['⇧↵'])
})

test('other platforms spell modifiers out', () => {
  expect(formatShortcut('CmdOrCtrl+Shift+P', false)).toEqual(['Ctrl+Shift+P'])
  expect(formatShortcut('$mod+K $mod+T', false)).toEqual(['Ctrl+K', 'Ctrl+T'])
})

test('the plus key itself', () => {
  expect(formatShortcut('CmdOrCtrl++', true)).toEqual(['⌘+'])
})
