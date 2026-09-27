import { afterEach, describe, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { createCommandService } from './command-service'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})

function setup() {
  const service = createCommandService()
  cleanups.push(service.listen(window))
  return service
}

describe('command service', () => {
  test('a key runs its command', async () => {
    const service = setup()
    const run = vi.fn()
    service.registerCommand({ id: 'test.run', title: 'Run', run })
    service.registerKeybinding({ key: 'Alt+KeyR', command: 'test.run' })
    await userEvent.keyboard('{Alt>}r{/Alt}')
    expect(run).toHaveBeenCalledOnce()
  })

  test('a user binding beats a plugin binding, which beats a default', async () => {
    const service = setup()
    const ran: string[] = []
    for (const id of ['a', 'b', 'c']) service.registerCommand({ id, title: id, run: () => ran.push(id) })
    service.registerKeybinding({ key: 'Alt+KeyK', command: 'c', source: 'user' })
    service.registerKeybinding({ key: 'Alt+KeyK', command: 'b', source: 'plugin' })
    service.registerKeybinding({ key: 'Alt+KeyK', command: 'a' })
    await userEvent.keyboard('{Alt>}k{/Alt}')
    expect(ran).toEqual(['c'])
    expect(service.keybindingFor('c')).toBe('Alt+KeyK')
    expect(service.keybindingFor('a')).toBeUndefined()
  })

  test('a when clause decides between bindings on the same key', async () => {
    const service = setup()
    const ran: string[] = []
    service.registerCommand({ id: 'terminal.clear', title: 'Clear', run: () => ran.push('terminal') })
    service.registerCommand({ id: 'chat.clear', title: 'Clear', run: () => ran.push('chat') })
    service.registerKeybinding({ key: 'Alt+KeyL', command: 'terminal.clear', when: "focus == 'terminal'" })
    service.registerKeybinding({ key: 'Alt+KeyL', command: 'chat.clear', when: "focus == 'chat'" })
    service.setContext('focus', 'chat')
    await userEvent.keyboard('{Alt>}l{/Alt}')
    service.setContext('focus', 'terminal')
    await userEvent.keyboard('{Alt>}l{/Alt}')
    expect(ran).toEqual(['chat', 'terminal'])
  })

  test('!inputFocus keeps a binding out of text fields', async () => {
    const service = setup()
    const run = vi.fn()
    service.registerCommand({ id: 'test.run', title: 'Run', run })
    service.registerKeybinding({ key: 'Alt+KeyJ', command: 'test.run', when: '!inputFocus' })
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    await userEvent.keyboard('{Alt>}j{/Alt}')
    expect(run).not.toHaveBeenCalled()
    input.blur()
    await userEvent.keyboard('{Alt>}j{/Alt}')
    expect(run).toHaveBeenCalledOnce()
  })

  test('a chord runs only after its second press', async () => {
    const service = setup()
    const run = vi.fn()
    service.registerCommand({ id: 'test.chord', title: 'Chord', run })
    service.registerKeybinding({ key: 'Alt+KeyK Alt+KeyS', command: 'test.chord' })
    await userEvent.keyboard('{Alt>}k{/Alt}')
    expect(run).not.toHaveBeenCalled()
    await userEvent.keyboard('{Alt>}s{/Alt}')
    expect(run).toHaveBeenCalledOnce()
  })

  test('disposing a command or binding removes it', async () => {
    const service = setup()
    const run = vi.fn()
    const dropCommand = service.registerCommand({ id: 'test.run', title: 'Run', run })
    const dropBinding = service.registerKeybinding({ key: 'Alt+KeyD', command: 'test.run' })
    dropBinding()
    await userEvent.keyboard('{Alt>}d{/Alt}')
    expect(run).not.toHaveBeenCalled()
    dropCommand()
    expect(service.execute('test.run')).toBe(false)
    expect(service.commands()).toEqual([])
  })
})
