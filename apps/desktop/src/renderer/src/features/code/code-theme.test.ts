import { expect, it } from 'vitest'
import { createHighlighter } from 'shiki'
import palettes from '../../../../../../../crates/ade-core/src/appearance/builtin.json'
import { adeCodeTheme, applyCodeTheme } from './code-theme'

it('recolors real Shiki tokens without replacing code, selection or scroll state', async () => {
  const highlighter = await createHighlighter({ themes: [adeCodeTheme], langs: ['javascript'] })
  const host = document.createElement('div')
  document.body.append(host)
  try {
    host.style.cssText = 'height: 40px; overflow: auto'
    host.innerHTML = highlighter.codeToHtml('// comment\nconst answer = "hello";\nconst count = 42;\n'.repeat(10), {
      lang: 'javascript',
      theme: adeCodeTheme.name!,
    })
    applyCodeTheme(host, palettes.graphite)
    const keyword = [...host.querySelectorAll('span[style]')].find((node) => node.textContent === 'const')!
    const string = [...host.querySelectorAll('span[style]')].find((node) => node.textContent?.trim() === '"hello"')!
    expect(keyword, host.innerHTML).toBeDefined()
    expect(string, host.innerHTML).toBeDefined()
    expect(getComputedStyle(keyword).color).toBe('rgb(138, 180, 248)')
    expect(getComputedStyle(string).color).toBe('rgb(128, 214, 165)')
    expect(getComputedStyle(keyword, '::selection').backgroundColor).toBe('rgb(40, 60, 85)')
    expect(getComputedStyle(keyword, '::selection').color).toBe('rgb(236, 238, 242)')
    const number = [...host.querySelectorAll('span[style]')].find((node) => node.textContent?.trim() === '42')!
    const comment = [...host.querySelectorAll('span[style]')].find((node) => node.textContent === '// comment')!
    const identifier = [...host.querySelectorAll('span[style]')].find((node) => node.textContent?.trim() === 'answer')!
    expect(getComputedStyle(number).color).toBe('rgb(230, 193, 122)')
    expect(getComputedStyle(comment).color).toBe('rgb(169, 176, 188)')
    expect(getComputedStyle(identifier).color).toBe('rgb(236, 238, 242)')
    expect(getComputedStyle(host.querySelector('pre')!).backgroundColor).toBe('rgb(16, 17, 19)')
    host.scrollTop = 30
    const range = document.createRange()
    range.selectNodeContents(keyword)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const before = host.innerHTML
    applyCodeTheme(host, palettes.chalk)
    expect(getComputedStyle(keyword).color).toBe('rgb(36, 91, 168)')
    expect(getComputedStyle(string).color).toBe('rgb(36, 102, 61)')
    expect(getComputedStyle(keyword, '::selection').backgroundColor).toBe('rgb(220, 232, 250)')
    expect(getComputedStyle(keyword, '::selection').color).toBe('rgb(32, 36, 43)')
    expect(getComputedStyle(number).color).toBe('rgb(128, 80, 0)')
    expect(getComputedStyle(comment).color).toBe('rgb(83, 93, 107)')
    expect(getComputedStyle(identifier).color).toBe('rgb(32, 36, 43)')
    expect(getComputedStyle(host.querySelector('pre')!).backgroundColor).toBe('rgb(232, 235, 239)')
    expect(host.innerHTML).toBe(before)
    expect(host.contains(keyword)).toBe(true)
    expect(host.scrollTop).toBe(30)
    expect(selection.toString()).toBe('const')
    // Without a committed startup snapshot, code inherits the built-in app tokens.
    for (const [role, color] of Object.entries(palettes.graphite)) host.style.setProperty(`--${role}`, color)
    applyCodeTheme(host, {})
    expect(getComputedStyle(keyword).color).toBe('rgb(138, 180, 248)')
    expect(getComputedStyle(host.querySelector('pre')!).backgroundColor).toBe('rgb(16, 17, 19)')
  } finally {
    host.remove()
    highlighter.dispose()
  }
})
