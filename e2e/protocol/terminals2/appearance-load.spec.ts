import { isDeepStrictEqual } from 'node:util'
import { expect, primaryShell, test } from '../fixtures'
import { terminalMetrics, TerminalStream } from '../fixtures/terminals'
import type { GhosttyColor, GhosttySnapshot } from '../../../packages/terminal/src/ghostty/core'
import { openView } from './viewer'

function indexedCellColor(snapshot: GhosttySnapshot, marker: string): GhosttyColor {
  for (const row of snapshot.rowData) {
    const index = row.text.indexOf(marker)
    if (index < 0) continue
    const cell = row.cells[index]
    if (!cell || cell.text !== marker[0]) throw new Error('Indexed terminal marker has no matching cell')
    return cell.foreground
  }
  throw new Error('Indexed terminal marker is absent from the Ghostty snapshot')
}

test('a committed palette repaints indexed cells without resizing or replacing the process', async ({ profile }) => {
  const { workspace } = await profile.call('workspace.open', { path: profile.defaultWorkspaceRoot })
  const terminalId = await primaryShell(profile, workspace.id)
  const view = await openView(profile, workspace.id, terminalId)
  const stream = TerminalStream.open(profile, workspace.id, terminalId)
  let lateView: typeof view | undefined
  try {
    const beforeAppearance = await profile.call('settings.appearance', {})
    let beforeMetrics = await terminalMetrics(profile, workspace.id, terminalId)
    if (!beforeMetrics) throw new Error('Terminal metrics are unavailable')
    const marker = 'ADE-INDEXED-CELL'
    stream.send({ op: 'input', data: "printf '\\x1b[38;5;7m" + marker + "\\x1b[0m\\n'" + '\n' })
    await stream.waitForText(new RegExp(marker))
    await expect.poll(() => view.viewer.screen.snapshot().rowData.some((row) => row.text.includes(marker))).toBe(true)
    const beforeScreen = view.viewer.screen.snapshot()
    const beforeIndexedColor = indexedCellColor(beforeScreen, marker)
    expect(beforeIndexedColor).toEqual(beforeAppearance.terminal.palette[7])
    beforeMetrics = await terminalMetrics(profile, workspace.id, terminalId)
    if (!beforeMetrics) throw new Error('Terminal metrics are unavailable after marker output')
    const palettes = (await profile.call('settings.palettes', {})).palettes.filter((palette) => palette.mode === 'dark')
    const palette = palettes.find((candidate) => candidate.id !== beforeAppearance.theme_id)
    if (!palette) throw new Error('No alternate shipped dark palette is available')
    const viewFrameStart = view.frames.length

    const changed = await profile.call('settings.set', {
      appearance: 'dark',
      app_dark_theme: palette.id,
      expected_appearance_revision: beforeAppearance.revision,
    })
    let applied = await profile.call('terminal.appearance.get', { workspace_id: workspace.id, terminal_id: terminalId })
    await expect
      .poll(async () => {
        applied = await profile.call('terminal.appearance.get', { workspace_id: workspace.id, terminal_id: terminalId })
        return applied.revision === changed.settings.appearance_revision && applied.selected_id === palette.id
      })
      .toBe(true)
    const desired = await profile.call('settings.appearance', {})
    expect(desired.propagation).toMatchObject({ state: 'applied', revision: changed.settings.appearance_revision })
    expect(applied.revision).toBe(changed.settings.appearance_revision)
    expect(applied.appearance).toEqual(desired.terminal)
    await expect
      .poll(() =>
        view.frames
          .slice(viewFrameStart)
          .some(
            (frame) =>
              frame.type === 'terminal_appearance' &&
              frame.run_id === beforeMetrics.run_id &&
              isDeepStrictEqual(frame.appearance, applied!.appearance),
          ),
      )
      .toBe(true)

    lateView = await openView(profile, workspace.id, terminalId)
    await expect
      .poll(() => {
        const screen = lateView!.viewer.screen.snapshot()
        return (
          screen.rowData.some((row) => row.text.includes(marker)) &&
          isDeepStrictEqual(indexedCellColor(screen, marker), desired.terminal.palette[7])
        )
      })
      .toBe(true)
    const afterScreen = view.viewer.screen.snapshot()
    expect(afterScreen.cols).toBe(beforeScreen.cols)
    expect(afterScreen.rows).toBe(beforeScreen.rows)
    expect(afterScreen.dirtyRows.size).toBeGreaterThan(0)
    expect(afterScreen.foreground).toEqual(desired.terminal.foreground)
    expect(indexedCellColor(afterScreen, marker)).toEqual(desired.terminal.palette[7])
    expect(indexedCellColor(afterScreen, marker)).not.toEqual(beforeIndexedColor)
    const afterMetrics = await terminalMetrics(profile, workspace.id, terminalId)
    expect(afterMetrics).toMatchObject({
      run_id: beforeMetrics.run_id,
      shell_pid: beforeMetrics.shell_pid,
      shell_running: true,
    })
    expect(afterMetrics?.terminal_bytes).toBe(beforeMetrics.terminal_bytes)
  } finally {
    lateView?.dispose()
    stream.close()
    view.dispose()
  }
})
