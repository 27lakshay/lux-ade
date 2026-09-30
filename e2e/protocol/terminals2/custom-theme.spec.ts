import type { TerminalSnapshotFrame } from '../../../packages/contracts/dist/index.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, primaryShell, test } from '../fixtures'
import { queryProgram } from '../fixtures/appearance'
import { replayText, type TerminalFrame } from '../fixtures/terminals'
import { openView } from './viewer'

test('custom terminal updates reach native indexed queries, every view and recovery without restarting the shell', async ({
  profile,
}) => {
  const source = (color: string) =>
    JSON.stringify({
      format: 'ade-theme',
      version: 1,
      id: 'user:terminal',
      name: 'Custom terminal',
      mode: 'light',
      provenance: { kind: 'user' },
      terminal: {
        defaults: 'ade:chalk',
        tokens: { 'terminal-foreground': color, 'terminal-ansi-255': '#abcdef', 'terminal-selection': '#11223380' },
      },
    })
  await profile.call('themes.install', { items: [{ source: source('#123456'), expected_revision: 0 }] })
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:terminal' } })
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const script = join(profile.root, 'custom-query.py')
  const program = queryProgram.replace(String.raw`\x1b]12;?\x07`, String.raw`\x1b]12;?\x07\x1b]4;255;?\x07`)
  await writeFile(script, program)
  const send = async () => {
    const sent = await profile.cli('terminal', 'send', workspace.id, terminalId, `python3 '${script}'`)
    expect(sent.code, sent.stderr).toBe(0)
  }
  await send()
  await expect
    .poll(async () =>
      replayText((await profile.cli('terminal', 'inspect', workspace.id, terminalId)).json as TerminalFrame),
    )
    .toContain('APPEARANCE:')
  const views = [await openView(profile, workspace.id, terminalId), await openView(profile, workspace.id, terminalId)]
  try {
    const first = await views[0]!.until('native custom replies', (state) =>
      state.lines.some((line) => line.startsWith('APPEARANCE:')),
    )
    const reply = Buffer.from(
      first.lines
        .join('')
        .split('APPEARANCE:')[1]!
        .match(/^[a-f0-9]+/)![0],
      'hex',
    ).toString()
    expect(reply).toContain('\x1b]10;rgb:1212/3434/5656')
    expect(reply).toContain('\x1b]4;255;rgb:abab/cdcd/efef')
    expect(reply).toContain('\x1b[?997;2n')
    for (const view of views) expect(view.viewer.screen.snapshot().foreground).toEqual({ r: 18, g: 52, b: 86 })
    const before = (await profile.cli('terminal', 'inspect', workspace.id, terminalId))
      .json as unknown as TerminalSnapshotFrame
    await profile.call('themes.install', { items: [{ source: source('#654321'), expected_revision: 1 }] })
    for (const view of views)
      await expect.poll(() => view.viewer.screen.snapshot().foreground).toEqual({ r: 101, g: 67, b: 33 })
    for (const view of views.splice(0)) view.dispose()
    await profile.restartDaemon('kill')
    const restored = await openView(profile, workspace.id, terminalId)
    const companion = await openView(profile, workspace.id, terminalId)
    try {
      expect(restored.viewer.screen.snapshot().foreground).toEqual({ r: 101, g: 67, b: 33 })
      const after = (await profile.cli('terminal', 'inspect', workspace.id, terminalId))
        .json as unknown as TerminalSnapshotFrame
      expect(after.run_id).toBe(before.run_id)
      expect(after.metrics.shell_pid).toBe(before.metrics.shell_pid)
      expect(after.metrics.terminal_bytes).toBeGreaterThanOrEqual(before.metrics.terminal_bytes)
      expect((await profile.call('settings.appearance', {})).terminal.palette[255]).toEqual({ r: 171, g: 205, b: 239 })
      const plan = await profile.call('themes.removal', { id: 'user:terminal', after_key: null })
      expect(plan.impacts).toEqual([
        expect.objectContaining({ consumer: 'terminal', slot: 'fixed', fallback_id: 'ade:chalk' }),
      ])
      await profile.call('themes.remove', {
        id: 'user:terminal',
        expected_revision: plan.theme.revision,
        expected_appearance_revision: plan.appearance_revision,
      })
      for (const view of [restored, companion])
        await expect.poll(() => view.viewer.screen.snapshot().foreground).toEqual({ r: 32, g: 36, b: 43 })
      await writeFile(script, program.replace('APPEARANCE:', 'REMOVAL:'))
      await send()
      const removal = await restored.until('native fallback replies after removal', (state) =>
        state.lines.some((line) => line.startsWith('REMOVAL:')),
      )
      const fallback = Buffer.from(
        removal.lines
          .join('')
          .split('REMOVAL:')[1]!
          .match(/^[a-f0-9]+/)![0],
        'hex',
      ).toString()
      expect(fallback).toContain('\x1b]10;rgb:2020/2424/2b2b')
      expect(fallback).toContain('\x1b]4;255;rgb:eeee/eeee/eeee')
      expect(fallback).toContain('\x1b[?997;2n')
      const removed = (await profile.cli('terminal', 'inspect', workspace.id, terminalId))
        .json as unknown as TerminalSnapshotFrame
      expect(removed.run_id).toBe(before.run_id)
      expect(removed.metrics.shell_pid).toBe(before.metrics.shell_pid)
    } finally {
      restored.dispose()
      companion.dispose()
    }
  } finally {
    for (const view of views) view.dispose()
  }
})
