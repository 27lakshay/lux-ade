import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, rpc, stopManagedProfile, stopManagedProfiles, type ManagedProfileOwner } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const cli = resolve('apps/cli/dist/index.js')
const control = resolve('target/debug/ade-control')
const desktopDirectory = resolve('apps/desktop')
const electronExecutable = createRequire(join(desktopDirectory, 'package.json'))('electron') as string

type Result = { code: number; output: Record<string, unknown> }

async function command(environment: NodeJS.ProcessEnv, ...args: string[]): Promise<Result> {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { env: environment, timeout: 40_000 })
    return { code: 0, output: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as Error & { code?: number; stderr?: string }
    if (typeof failure.code !== 'number' || !failure.stderr) throw failure
    const errorLine = failure.stderr.trim().split('\n').at(-1)
    if (!errorLine) throw failure
    return { code: failure.code, output: JSON.parse(errorLine) as Record<string, unknown> }
  }
}

async function owner(home: string): Promise<ManagedProfileOwner> {
  const located = await execFileAsync(control, ['runtime', 'locate', '--home', home])
  const socket = (JSON.parse(located.stdout) as { socket: string }).socket
  const captured = await managedProfileOwner(socket)
  const runtime = await rpc(captured.runtimeSocket, { op: 'hello' })
  if (runtime.instance_id !== captured.runtimeInstance || runtime.pid !== captured.runtimePid ||
    typeof runtime.data_directory !== 'string' ||
    await realpath(runtime.data_directory) !== await realpath(join(home, 'data'))) {
    throw new Error(`Profile owner changed or belongs to another data directory at ${socket}`)
  }
  return captured
}

test('CLI targets GUI-created managed profiles without changing the desktop selection', async () => {
  const fixtures = await mkdtemp(join(tmpdir(), 'ade-cli-managed-profiles-'))
  const personalFolder = join(fixtures, 'personal-project')
  const workFolder = join(fixtures, 'work-project')
  await mkdir(personalFolder)
  await mkdir(workFolder)
  const personalRoot = await realpath(personalFolder)
  const workRoot = await realpath(workFolder)
  const profilesHome = join(fixtures, 'profiles')
  const { ADE_SOCKET: _fixedSocket, ...ambient } = process.env
  const environment = { ...ambient, ADE_PROFILES_HOME: profilesHome,
    ADE_DAEMON_BIN: resolve('target/debug/ade-daemon') }
  const application = await electron.launch({ executablePath: electronExecutable, args: [desktopDirectory],
    env: { ...environment, ADE_E2E_USER_DATA_DIR: join(fixtures, 'electron'), ADE_E2E_HIDE_WINDOW: '1' } })
  const owners: ManagedProfileOwner[] = []
  const uncapturedHomes = new Set<string>()
  try {
    const window = await application.firstWindow()
    await window.getByRole('textbox', { name: 'New profile' }).fill('Personal')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Personal')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const personal = (await window.evaluate(() => window.adeHost.getProfileState())).profiles
      .find((profile) => profile.name === 'Personal')!
    uncapturedHomes.add(personal.home)
    owners.push(await owner(personal.home))
    uncapturedHomes.delete(personal.home)
    await window.getByRole('textbox', { name: 'Open folder' }).fill(personalFolder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await expect(window.locator('.workspace-root')).toHaveText(personalRoot)
    await window.getByRole('button', { name: 'New conversation' }).click()
    await expect(window.getByRole('navigation', { name: 'Conversations' }).locator('li')).toHaveCount(1)

    await window.getByRole('textbox', { name: 'New profile' }).fill('Work')
    await window.getByRole('button', { name: 'Create' }).click()
    await expect(window.getByText('Active profile: Work')).toBeVisible()
    await expect(window.locator('header').getByRole('status')).toHaveText('connected')
    const work = (await window.evaluate(() => window.adeHost.getProfileState())).profiles
      .find((profile) => profile.name === 'Work')!
    uncapturedHomes.add(work.home)
    owners.push(await owner(work.home))
    uncapturedHomes.delete(work.home)
    await window.getByRole('textbox', { name: 'Open folder' }).fill(workFolder)
    await window.getByRole('button', { name: 'Open folder' }).click()
    await expect(window.locator('.workspace-root')).toHaveText(workRoot)

    const list = await command(environment, 'profile', 'list')
    expect(list).toMatchObject({ code: 0, output: { type: 'profiles', selected_id: work.id,
      profiles: expect.arrayContaining([
        expect.objectContaining({ id: personal.id, name: 'Personal', selected: false }),
        expect.objectContaining({ id: work.id, name: 'Work', selected: true }),
      ]) } })
    // The desktop is still on Work; the CLI must relaunch the dormant Personal
    // daemon from its exact profile identity and retain GUI-created state.
    await stopManagedProfile(owners[0])
    owners.shift()
    uncapturedHomes.add(personal.home)
    const restarted = await command(environment, '--profile', personal.id, 'status')
    owners.unshift(await owner(personal.home))
    uncapturedHomes.delete(personal.home)
    expect(restarted).toMatchObject({ code: 0, output: { type: 'hello' } })
    const personalWorkspaces = await command(environment, '--profile', personal.id, 'workspace', 'list')
    const workWorkspaces = await command(environment, '--profile', work.id, 'workspace', 'list')
    expect(personalWorkspaces.code).toBe(0)
    expect(workWorkspaces.code).toBe(0)
    const personalItems = personalWorkspaces.output.workspaces as Array<{ id: string; root: string }>
    const workItems = workWorkspaces.output.workspaces as Array<{ id: string; root: string }>
    expect(personalItems).toEqual(expect.arrayContaining([expect.objectContaining({ root: personalRoot })]))
    expect(workItems).toEqual(expect.arrayContaining([expect.objectContaining({ root: workRoot })]))
    expect(workItems).not.toEqual(expect.arrayContaining([expect.objectContaining({ root: personalRoot })]))
    const conversations = await command(environment, '--profile', personal.id, 'conversation', 'list')
    expect(conversations.code).toBe(0)
    const personalConversation = (conversations.output.conversations as Array<{ id: string }>)[0]
    expect(personalConversation?.id).toBeTruthy()
    expect((await command(environment, '--profile', personal.id, 'conversation', 'inspect',
      personalConversation.id)).output.conversation).toMatchObject({ id: personalConversation.id })
    const wrongProfile = await command(environment, '--profile', work.id, 'conversation', 'inspect', personalConversation.id)
    expect(wrongProfile).toMatchObject({ code: 7, output: { type: 'error', code: 'daemon' } })

    const unknown = await command(environment, '--profile', '11111111-1111-4111-8111-111111111111', 'status')
    expect(unknown).toMatchObject({ code: 2, output: { type: 'error', code: 'invalid_request' } })
    const conflict = await command({ ...environment, ADE_SOCKET: owners[0].socket },
      '--profile', work.id, 'status')
    expect(conflict).toMatchObject({ code: 2, output: { type: 'error', code: 'usage' } })
    const explicitConflict = await command(environment, '--socket', owners[0].socket,
      '--profile', work.id, 'status')
    expect(explicitConflict).toMatchObject({ code: 2, output: { type: 'error', code: 'usage' } })
    const invalid = await command(environment, '--profile', 'not-an-id', 'status')
    expect(invalid).toMatchObject({ code: 2, output: { type: 'error', code: 'invalid_request' } })
    expect((await command(environment, 'profile', 'list')).output.selected_id).toBe(work.id)
    expect((await window.evaluate(() => window.adeHost.getProfileState())).activeId).toBe(work.id)
  } finally {
    await application.close().catch(() => undefined)
    const captureErrors: string[] = []
    for (const home of uncapturedHomes) {
      try { owners.push(await owner(home)) }
      catch (error) { captureErrors.push(`${home}: ${String(error)}`) }
    }
    await stopManagedProfiles(owners)
    if (captureErrors.length) throw new Error(`A profile owner could not be verified; retain test data at ${fixtures}: ${captureErrors.join('; ')}`)
    await rm(fixtures, { recursive: true, force: true })
  }
})
