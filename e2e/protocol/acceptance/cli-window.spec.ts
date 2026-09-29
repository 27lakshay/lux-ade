// The daemon authority effort's acceptance run (.scratch/daemon-authority/README.md): a window is
// driven through the CLI alone, with no desktop. A worktree workspace is created, a window opened on
// it, a pane split, a terminal opened in the new pane and a command run in it; closing its tab while
// the command runs is refused as busy, and a forced close ends it and removes the tab and its pane.
import { expect, test, type ScratchProfile } from '../fixtures'

type Json = Record<string, any>

/** Runs an `ade` command that must succeed and returns its JSON reply. */
async function ade(profile: ScratchProfile, ...args: string[]): Promise<Json> {
  const result = await profile.cli(...args)
  expect(result.code, `ade ${args.join(' ')}: ${result.stderr}`).toBe(0)
  return result.json as Json
}

/** The window's layout for its shown workspace, as `ade layout get` prints it. */
const layoutOf = async (profile: ScratchProfile, window: string) =>
  (await ade(profile, 'layout', 'get', '--window', window)).layout.layout as Json

test('the CLI alone creates a worktree, opens a window on it, splits it and runs a terminal it can close', async ({
  ade: harness,
  profile,
}) => {
  test.setTimeout(120_000)
  const repo = await harness.repo()
  const main = (await ade(profile, 'workspace', 'open', repo.path)).workspace as Json

  const created = await ade(
    profile,
    '--operation-id',
    'acceptance-worktree',
    'workspace',
    'create-worktree',
    main.project_id,
    'Acceptance',
    '--wait',
  )
  expect(created).toMatchObject({ status: 'succeeded' })
  const workspace = created.workspace_id as string

  const window = 'window-acceptance'
  await ade(profile, 'window', 'create', workspace, '--id', window)
  const first = (await layoutOf(profile, window)).root.id as string
  await ade(profile, 'pane', 'split', first, '--direction', 'row', '--id', 'pane-right', '--window', window)
  expect((await layoutOf(profile, window)).root).toMatchObject({ type: 'split', direction: 'row' })

  const terminal = (
    await ade(profile, 'terminal', 'create', workspace, '--operation-id', 'acceptance-shell', '--title', 'build')
  ).terminal_id as string
  await ade(
    profile,
    'tab',
    'open',
    'terminal',
    terminal,
    '--pane',
    'pane-right',
    '--id',
    'tab-build',
    '--window',
    window,
  )
  expect((await layoutOf(profile, window)).tabs['tab-build']).toMatchObject({
    target: { kind: 'terminal', id: terminal },
  })

  // A command runs in the terminal; the daemon reports it busy, naming the command.
  await ade(profile, 'terminal', 'send', workspace, terminal, 'sleep 30\n')
  await expect
    .poll(
      async () =>
        ((await ade(profile, 'terminal', 'list', workspace)).terminals as Json[]).find((item) => item.id === terminal),
      { timeout: 20_000 },
    )
    .toMatchObject({ busy: true, foreground: 'sleep' })

  // Closing its tab is refused while the command runs, and changes nothing.
  const refused = await profile.cli('tab', 'close', 'tab-build', '--window', window)
  expect(refused.code).toBe(22)
  expect(refused.json).toMatchObject({ code: 'terminal_busy' })
  expect((await layoutOf(profile, window)).tabs['tab-build']).toBeDefined()

  // Forced, the close ends the command, removes the terminal and its tab.
  await ade(profile, 'tab', 'close', 'tab-build', '--window', window, '--force')
  const layout = await layoutOf(profile, window)
  expect(layout.tabs['tab-build']).toBeUndefined()
  // The right pane held only that tab, so it closed with it: the window is back to one pane.
  expect(layout.root).toMatchObject({ type: 'pane', id: first })
  const left = ((await ade(profile, 'terminal', 'list', workspace)).terminals as Json[]).map((item) => item.id)
  expect(left).not.toContain(terminal)
})
