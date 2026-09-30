import { expect, it } from 'vitest'
import { FileDiff, UnresolvedFile } from '@pierre/diffs'
import palettes from '../../../../../../../crates/ade-core/src/appearance/builtin.json'
import { applyCodeTheme } from './code-theme'
import { applyPierreTheme, registerPierreTheme, pierreThemeCSS } from './pierre-theme'

it('recolors a real Pierre diff without replacing highlighted nodes or losing selection and scroll', async () => {
  const theme = await registerPierreTheme()
  const host = document.createElement('div')
  host.style.cssText = 'height: 100px; overflow: auto'
  document.body.append(host)
  applyCodeTheme(host, palettes.graphite)
  applyPierreTheme(host)
  const diff = new FileDiff({
    theme,
    unsafeCSS: pierreThemeCSS,
    diffStyle: 'unified',
    disableFileHeader: true,
    disableErrorHandling: true,
    lineDiffType: 'word',
  })
  try {
    diff.render({
      oldFile: { name: 'example.js', contents: 'const count = 10;\n'.repeat(20) },
      newFile: { name: 'example.js', contents: 'const count = 11;\n'.repeat(20) },
      containerWrapper: host,
    })
    const root = () => host.querySelector('diffs-container')?.shadowRoot
    const keyword = () =>
      [...(root()?.querySelectorAll('span[style]') ?? [])].find((node) => node.textContent === 'const') as
        | HTMLElement
        | undefined
    await expect.poll(() => keyword() && getComputedStyle(keyword()!).color).toBe('rgb(138, 180, 248)')
    const original = keyword()!
    const line = root()!.querySelector('[data-line-type="change-addition"]')!
    const background = (node = line) => {
      const context = document.createElement('canvas').getContext('2d')!
      context.fillStyle = getComputedStyle(node).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data)
    }
    await expect.poll(() => background()).toEqual([41, 53, 51, 255])
    const deletion = root()!.querySelector('[data-line][data-line-type="change-deletion"]')!
    expect(background(deletion)).toEqual([63, 49, 53, 255])
    const gutter = root()!.querySelector('[data-column-number]')!
    expect(getComputedStyle(gutter).color).toBe('rgb(169, 176, 188)')
    const addedWord = root()!.querySelector('[data-line-type="change-addition"] [data-diff-span]')!
    const deletedWord = root()!.querySelector('[data-line-type="change-deletion"] [data-diff-span]')!
    expect(addedWord).toBeTruthy()
    expect(deletedWord).toBeTruthy()
    expect(background(addedWord)).toEqual([44, 66, 55, 255])
    expect(background(deletedWord)).toEqual([76, 51, 53, 255])
    diff.setSelectedLines({ start: 2, end: 2, side: 'additions' })
    await expect.poll(() => root()!.querySelectorAll('[data-line][data-selected-line]').length).toBe(1)
    const selected = root()!.querySelector('[data-line][data-selected-line]')!
    const selectedColor = background(selected)
    host.scrollTop = 50
    expect(host.scrollTop).toBe(50)
    applyCodeTheme(host, palettes.chalk)
    expect(getComputedStyle(original).color).toBe('rgb(36, 91, 168)')
    expect(background()).toEqual([233, 239, 237, 255])
    expect(background(deletion)).toEqual([243, 235, 236, 255])
    expect(getComputedStyle(gutter).color).toBe('rgb(83, 93, 107)')
    expect(background(addedWord)).toEqual([183, 202, 194, 255])
    expect(background(deletedWord)).toEqual([216, 188, 194, 255])
    expect(root()!.querySelector('[data-line][data-selected-line]')).toBe(selected)
    expect(background(selected)).not.toEqual(selectedColor)
    expect(keyword()).toBe(original)
    expect(host.scrollTop).toBe(50)
  } finally {
    diff.cleanUp()
    host.remove()
  }
})

it('recolors real unresolved conflict regions and markers without replacing them', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  applyCodeTheme(host, palettes.graphite)
  applyPierreTheme(host)
  const unresolved = new UnresolvedFile({
    theme: await registerPierreTheme(),
    unsafeCSS: pierreThemeCSS,
    disableFileHeader: true,
    disableErrorHandling: true,
    mergeConflictActionsType: 'none',
  })
  try {
    unresolved.render({
      file: {
        name: 'conflict.js',
        contents: 'function answer() {\n<<<<<<< HEAD\nreturn 10;\n=======\nreturn 11;\n>>>>>>> incoming\n}\n',
      },
      containerWrapper: host,
    })
    const root = () => host.querySelector('diffs-container')?.shadowRoot
    const current = () => root()?.querySelector('[data-line][data-merge-conflict="current"]')
    const incoming = () => root()?.querySelector('[data-line][data-merge-conflict="incoming"]')
    await expect.poll(() => current() && incoming()).toBeTruthy()
    const currentNode = current()!
    const incomingNode = incoming()!
    const marker = root()!.querySelector('[data-merge-conflict-marker-row]')!
    expect(marker).toBeTruthy()
    expect(getComputedStyle(marker, '::after').color).toBe('rgb(169, 176, 188)')
    const color = (node: Element) => {
      const context = document.createElement('canvas').getContext('2d')!
      context.fillStyle = getComputedStyle(node).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data)
    }
    const literal = (value: string) => {
      const context = document.createElement('canvas').getContext('2d')!
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data)
    }
    expect(color(currentNode)).toEqual(literal(palettes.graphite['diff-add-muted']))
    expect(color(incomingNode)).toEqual(literal(palettes.graphite['info-muted']))
    applyCodeTheme(host, palettes.chalk)
    expect(color(currentNode)).toEqual(literal(palettes.chalk['diff-add-muted']))
    expect(color(incomingNode)).toEqual(literal(palettes.chalk['info-muted']))
    expect(current()).toBe(currentNode)
    expect(incoming()).toBe(incomingNode)
    expect(getComputedStyle(marker, '::after').color).toBe('rgb(83, 93, 107)')
    expect(root()!.querySelector('[data-merge-conflict-marker-row]')).toBe(marker)
  } finally {
    unresolved.cleanUp()
    host.remove()
  }
})
