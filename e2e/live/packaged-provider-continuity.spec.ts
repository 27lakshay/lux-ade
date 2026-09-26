import { expect, test, _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { managedProfileOwner, rpc, stopManagedProfile, stopOrphanRuntime,
  type ManagedProfileOwner } from '../fixtures/daemon'

const execFileAsync = promisify(execFile)
const app = resolve(process.env.ADE_E2E_PACKAGE_APP ?? 'dist/electron/mac-arm64/Lux ADE.app')
const executable = join(app, 'Contents/MacOS/Lux ADE')
const control = join(app, 'Contents/MacOS/ade-control')

async function testOwner(socket: string, home: string): Promise<ManagedProfileOwner> {
  const daemon = await rpc(socket, { op: 'hello' })
  if (typeof daemon.runtime_socket !== 'string') throw new Error('Profile daemon omitted its runtime endpoint')
  const runtime = await rpc(daemon.runtime_socket, { op: 'hello' })
  if (typeof runtime.data_directory !== 'string' ||
    await realpath(runtime.data_directory) !== await realpath(join(home, 'data'))) {
    throw new Error(`Refusing a profile daemon outside the test-owned home: ${socket}`)
  }
  return managedProfileOwner(socket)
}

function processExited(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

for (const provider of ['codex', 'claude'] as const) {
  test(`packaged app retains a real ${provider} turn after closing and reopening`, async ({}, testInfo) => {
    test.skip(process.env.ADE_RUN_LIVE_PROVIDERS !== '1', 'Opt in to real provider usage')
    test.setTimeout(180_000)
    if (provider === 'claude' && !process.env.CLAUDE_CONFIG_DIR) {
      throw new Error('This live Claude check requires a pre-existing CLAUDE_CONFIG_DIR')
    }
    const claudeConfig = provider === 'claude' ? await realpath(process.env.CLAUDE_CONFIG_DIR!) : undefined
    const directory = await mkdtemp(join(tmpdir(), `ade-live-package-${provider}-`))
    const folder = join(directory, 'project')
    const profilesHome = join(directory, 'profiles')
    const inherited = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL',
      'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING']
      .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))
    const environment = { ...inherited, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      ADE_PROFILES_HOME: profilesHome,
      ADE_E2E_USER_DATA_DIR: join(directory, 'electron'),
      ADE_E2E_HIDE_WINDOW: '1',
      ...(claudeConfig ? { CLAUDE_CONFIG_DIR: claudeConfig } : {}),
    }
    if (environment.CLAUDE_CONFIG_DIR?.startsWith(`${directory}${sep}`)) {
      throw new Error('The live Claude config must predate this isolated ADE test')
    }
    let application: Awaited<ReturnType<typeof electron.launch>> | null = null
    let owner: ManagedProfileOwner | null = null
    let profileHome: string | null = null
    try {
      await mkdir(folder)
      application = await electron.launch({ executablePath: executable, cwd: directory, env: environment })
      let window = await application.firstWindow()
      await window.getByRole('textbox', { name: 'New profile' }).fill(`Live ${provider}`)
      await window.getByRole('button', { name: 'Create' }).click()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      const state = await window.evaluate(() => window.adeHost.getProfileState())
      const profile = state.profiles.find((item) => item.id === state.activeId)
      expect(profile).toBeDefined()
      const registry = await realpath(profilesHome)
      profileHome = await realpath(profile!.home)
      if (!profileHome.startsWith(`${registry}${sep}`)) {
        throw new Error(`GUI profile escaped isolated registry: ${profileHome}`)
      }
      const located = await execFileAsync(control, ['locate', '--home', profileHome], { env: environment })
      const socket = (JSON.parse(located.stdout) as { socket: string }).socket
      owner = await testOwner(socket, profileHome)
      await window.getByRole('textbox', { name: 'Open folder' }).fill(folder)
      await window.getByRole('button', { name: 'Open folder' }).click()
      await expect(window.getByText(await realpath(folder), { exact: true })).toBeVisible()

      await window.getByLabel('New conversation provider').selectOption(provider)
      await window.getByRole('button', { name: 'New conversation' }).click()
      const marker = `ADE_LIVE_PACKAGED_${provider.toUpperCase()}`
      const conversation = window.getByRole('region', { name: 'Conversation' })
      await conversation.getByRole('textbox', { name: 'Prompt' }).fill(
        `Do not use tools, read files, or change anything. Output exactly 200 numbered lines. Each line must contain ${marker}. Do not shorten the list or add commentary.`,
      )
      await conversation.getByRole('button', { name: 'Send' }).click()
      const catalog = await rpc(socket, { op: 'catalog.get' })
      const id = (catalog.catalog as { conversations: Array<{ id: string }> }).conversations[0].id
      await expect.poll(async () => (await rpc(socket, { op: 'conversation.get',
        conversation_id: id })).conversation.status, { timeout: 30_000 }).toMatch(/running|error/)
      const admitted = await rpc(socket, { op: 'conversation.get', conversation_id: id })
      if (admitted.conversation.status === 'error') {
        throw new Error(`Installed ${provider} turn failed: ${String(admitted.conversation.error)}`)
      }
      const before = await rpc(socket, { op: 'hello' })
      const nativeThread = (await rpc(socket, { op: 'conversation.get',
        conversation_id: id })).conversation.provider_thread_id
      expect(nativeThread).toBeTruthy()

      await application.close()
      application = null
      const closed = await rpc(socket, { op: 'hello' })
      expect(closed.boot_id).toBe(before.boot_id)
      expect(closed.runtime_instance).toBe(before.runtime_instance)
      expect((await rpc(socket, { op: 'conversation.get',
        conversation_id: id })).conversation.status).toBe('running')

      application = await electron.launch({ executablePath: executable, cwd: directory, env: environment })
      window = await application.firstWindow()
      await expect(window.locator('header').getByRole('status')).toHaveText('connected')
      await expect.poll(async () => (await rpc(socket, { op: 'conversation.get',
        conversation_id: id })).conversation.status, { timeout: 120_000 }).toMatch(/ready|error/)
      const after = await rpc(socket, { op: 'conversation.get', conversation_id: id })
      if (after.conversation.status === 'error') {
        throw new Error(`Installed ${provider} turn ended in error: ${String(after.conversation.error)}`)
      }
      expect(after.conversation.provider_thread_id).toBe(nativeThread)
      expect((after.messages as Array<{ role: string }>).filter((item) => item.role === 'user')).toHaveLength(1)
      expect((after.messages as Array<{ role: string; text: string }>).some((item) =>
        item.role === 'assistant' && item.text.includes(marker))).toBe(true)
      await expect(window.getByRole('region', { name: 'Conversation' })).toContainText(marker)
    } catch (error) {
      if (profileHome) {
        const log = await readFile(join(profileHome, 'daemon.log')).catch(() => Buffer.from('No daemon log'))
        await testInfo.attach(`installed-${provider}-daemon.log`, {
          body: log.subarray(-64 * 1024), contentType: 'text/plain',
        })
      }
      throw error
    } finally {
      let closeFailure: unknown
      try { await application?.close() } catch (error) { closeFailure = error }
      let stopFailure: unknown
      try {
        if (owner) await stopManagedProfile(owner)
        else {
          const listed = await execFileAsync(control, ['profiles', '--home', profilesHome, 'list'],
            { env: environment })
          const profiles = (JSON.parse(listed.stdout) as { profiles: Array<{ home: string }> }).profiles
          const registry = await realpath(profilesHome)
          for (const profile of profiles) {
            const home = await realpath(profile.home)
            if (!home.startsWith(`${registry}${sep}`)) {
              throw new Error(`Test profile escaped isolated registry: ${home}`)
            }
            const data = join(home, 'data')
            const located = await execFileAsync(control, ['locate', '--home', home], { env: environment })
            const socket = (JSON.parse(located.stdout) as { socket: string }).socket
            const hello = await rpc(socket, { op: 'hello' }, 500).catch(() => null)
            if (hello) {
              await stopManagedProfile(await testOwner(socket, home))
            } else {
              const log = await readFile(join(home, 'daemon.log'), 'utf8').catch(() => '')
              const launches = [...log.matchAll(/lux-ade daemon (\d+) listening at /g)]
              const pid = Number(launches.at(-1)?.[1])
              if (!Number.isSafeInteger(pid) || !processExited(pid)) {
                throw new Error(`Cannot prove the test daemon exited at ${socket}`)
              }
              await stopOrphanRuntime(data)
              throw new Error(`Cannot rule out a new daemon still starting at ${socket}`)
            }
          }
        }
      } catch (error) { stopFailure = error }
      if (closeFailure || stopFailure) {
        throw new Error(`Installed test cleanup is unconfirmed; retained ${directory}: ` +
          `${String(closeFailure ?? stopFailure)}`)
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
}
