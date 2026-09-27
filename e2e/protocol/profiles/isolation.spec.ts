// F007: independent profiles. Two managed profiles on one host, both started
// by the CLI through ade-control, keep separate processes, endpoints, data,
// records, accounts, plugins and browser data, before and after a restart. A
// physical checkout both profiles use is the one thing they share, and a
// conflict over it stays visible to both.
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRunning, prompts, send, startConversation, turnReply, waitForIdle, waitForMessage } from '../fixtures'
import { expect, test, type ManagedProfile } from '../fixtures/managed-profiles'
import { installAndEnable, stagePlugin } from '../fixtures/plugins'
import { adopt, claimsOn, exists, externalTree, launchShell, removeTree } from '../resources/steps'

type Seeded = {
  workspaceId: string
  conversationId: string
  accountId: string
  pluginId: string
  partition: string
  importId: string
}

/**
 * A Chrome `Default` profile with bookmarks under a scratch import home, read
 * by browser imports instead of the user's HOME.
 */
async function chromeBookmarks(root: string): Promise<string> {
  const home = join(root, 'browser-import-home')
  const directory = join(home, 'Library/Application Support/Google/Chrome/Default')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'Bookmarks'),
    JSON.stringify({
      version: 1,
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: 'Bookmarks bar',
          children: [
            { type: 'url', name: 'Example', url: 'https://example.com/' },
            { type: 'url', name: 'Docs', url: 'https://example.org/docs' },
          ],
        },
      },
    }),
  )
  return home
}

/** Give `profile` its own workspace, conversation with a finished turn, account, plugin state and browser partition. */
async function seed(profile: ManagedProfile, repoPath: string, label: string): Promise<Seeded> {
  const scratch = profile.asScratch()
  const { workspaceId, conversationId } = await startConversation(scratch, 'codex', repoPath)
  await send(scratch, conversationId, prompts.turn)
  await waitForMessage(scratch, conversationId, turnReply.codex)
  await waitForIdle(scratch, conversationId)
  const { account } = await profile.call('account.create', { provider: 'codex', name: `${label} account` })
  expect(await realpath(account.native_home)).toContain(await realpath(profile.dataDirectory))
  const { pluginId } = await installAndEnable(scratch, await stagePlugin(profile.root, 'backend'), `install-${label}`)
  await profile.call('plugin.record.put', { plugin_id: pluginId, namespace: 'notes', key: 'owner', value: { label } })
  const partition = `${label.toLowerCase()}-partition`
  const created = await profile.call('browser.partition.create', { partition_id: partition, name: `${label} browsing` })
  expect(created).toMatchObject({ profile_id: profile.id, created: true })
  const importId = `import-${label}`
  const imported = await profile.call('browser.import.run', {
    import_id: importId,
    partition_id: partition,
    source: 'chrome',
    classes: ['bookmarks'],
  })
  expect(imported).toMatchObject({
    profile_id: profile.id,
    partition_id: partition,
    classes: [{ class: 'bookmarks', imported: 2 }],
  })
  return { workspaceId, conversationId, accountId: account.id, pluginId, partition, importId }
}

/** Everything `profile` holds that the other profile seeded must be absent, and its own must be present. */
async function expectOnlyOwn(
  profile: ManagedProfile,
  own: Seeded,
  other: Seeded,
  label: string,
  otherProfile: ManagedProfile,
) {
  const catalog = await profile.call('catalog.get', {})
  const workspaceIds = catalog.catalog.workspaces.map((workspace) => workspace.id)
  expect(workspaceIds).toContain(own.workspaceId)
  expect(workspaceIds).not.toContain(other.workspaceId)

  const conversation = await profile.call('conversation.get', { conversation_id: own.conversationId })
  expect(conversation.messages.map((message) => (message as { text?: string }).text ?? '').join('\n')).toContain(
    turnReply.codex,
  )
  await expect(profile.call('conversation.get', { conversation_id: other.conversationId })).rejects.toThrow()

  const accounts = (await profile.call('account.list', {})).accounts.map((account) => account.id)
  expect(accounts).toContain(own.accountId)
  expect(accounts).not.toContain(other.accountId)

  const plugins = (await profile.call('plugin.list', {})).plugins
  expect(plugins.map((plugin) => plugin.id)).toEqual([own.pluginId])
  const records = await profile.call('plugin.record.list', { plugin_id: own.pluginId, namespace: 'notes' })
  expect(JSON.stringify(records)).toContain(`"label":"${label}"`)
  expect(JSON.stringify(records)).not.toContain(`"label":"${label === 'A' ? 'B' : 'A'}"`)

  const partitions = await profile.call('browser.partition.list', {})
  expect(partitions.profile_id).toBe(profile.id)
  // Every profile has the built-in default partition; the named one is this profile's alone.
  expect(partitions.partitions.map((partition) => partition.partition_id).sort()).toEqual(
    ['default', own.partition].sort(),
  )
  // The other profile's browser data is not reachable through this daemon.
  await expect(profile.call('browser.partition.list', { profile_id: otherProfile.id })).rejects.toThrow(/unavailable/)
  expect(await profile.call('browser.import.get', { import_id: own.importId })).toMatchObject({
    profile_id: profile.id,
    partition_id: own.partition,
    classes: [{ class: 'bookmarks', imported: 2 }],
  })
  await expect(profile.call('browser.import.get', { import_id: other.importId })).rejects.toThrow(/No browser import/)
}

test('two profiles keep separate processes, data, records, accounts, plugins and browser data, across a restart', async ({
  host,
  ade,
}) => {
  const importHome = await chromeBookmarks(ade.root)
  const a = await host.create('A', { env: { ADE_BROWSER_IMPORT_HOME: importHome } })
  const b = await host.create('B', { env: { ADE_BROWSER_IMPORT_HOME: importHome } })
  const startA = await a.cli('status')
  const startB = await b.cli('status')
  expect(startA.code, startA.stderr).toBe(0)
  expect(startB.code, startB.stderr).toBe(0)
  const helloA = (await a.hello())!
  const helloB = (await b.hello())!

  // Separate processes, endpoints and data directories.
  expect(helloA.pid).not.toBe(helloB.pid)
  expect(helloA.runtime_pid).not.toBe(helloB.runtime_pid)
  expect(helloA.runtime_instance).not.toBe(helloB.runtime_instance)
  expect(a.socket).not.toBe(b.socket)
  expect(helloA.runtime_socket).not.toBe(helloB.runtime_socket)
  const runtimeA = (await a.runtimeHello(helloA.runtime_socket))!
  const runtimeB = (await b.runtimeHello(helloB.runtime_socket))!
  expect(await realpath(runtimeA.data_directory as string)).toBe(await realpath(a.dataDirectory))
  expect(await realpath(runtimeB.data_directory as string)).toBe(await realpath(b.dataDirectory))

  const repoA = await ade.repo({ name: 'a-project' })
  const repoB = await ade.repo({ name: 'b-project' })
  const seededA = await seed(a, repoA.path, 'A')
  const seededB = await seed(b, repoB.path, 'B')

  // Each profile's provider ran in that profile only.
  expect((await a.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect((await b.mockCalls('codex')).filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect(new Set((await a.mockCalls('codex')).map((call) => call.pid))).not.toEqual(
    new Set((await b.mockCalls('codex')).map((call) => call.pid)),
  )

  await expectOnlyOwn(a, seededA, seededB, 'A', b)
  await expectOnlyOwn(b, seededB, seededA, 'B', a)

  // The CLI reads each profile's own records.
  const listedA = await a.cli('workspace', 'list')
  expect(JSON.stringify(listedA.json)).toContain(seededA.workspaceId)
  expect(JSON.stringify(listedA.json)).not.toContain(seededB.workspaceId)

  // A crash of one profile's whole backend leaves the other untouched.
  await a.killDaemon()
  await a.killRuntime(helloA.runtime_pid)
  expect(await b.hello()).toMatchObject({ pid: helloB.pid, boot_id: helloB.boot_id, runtime_pid: helloB.runtime_pid })
  expect(await isRunning(helloB.runtime_pid)).toBe(true)
  await expectOnlyOwn(b, seededB, seededA, 'B', a)

  // Stop B too, then start both again from the CLI: each finds its own state only.
  await b.stop()
  expect(await isRunning(helloB.pid)).toBe(false)
  expect(await isRunning(helloB.runtime_pid)).toBe(false)
  expect((await a.cli('status')).code).toBe(0)
  expect((await b.cli('status')).code).toBe(0)
  const againA = (await a.hello())!
  const againB = (await b.hello())!
  expect(againA.runtime_instance).not.toBe(helloA.runtime_instance)
  expect(againB.runtime_instance).not.toBe(helloB.runtime_instance)
  await expectOnlyOwn(a, seededA, seededB, 'A', b)
  await expectOnlyOwn(b, seededB, seededA, 'B', a)
})

test('starting one profile from the CLI neither starts nor selects the other', async ({ host }) => {
  const a = await host.create('A')
  const b = await host.create('B')
  expect((await b.cli('status')).code).toBe(0)
  expect(await a.hello()).toBeNull()
  const listed = await host.cli('profile', 'list')
  expect(listed.json).toMatchObject({ selected_id: a.id })
  expect(
    (listed.json!.profiles as Array<{ id: string; selected: boolean }>).map((profile) => [
      profile.id,
      profile.selected,
    ]),
  ).toEqual([
    [a.id, true],
    [b.id, false],
  ])
})

test('a checkout one profile works in stays a visible conflict for the other profile', async ({ host, ade, repo }) => {
  const worker = await host.create('Worker')
  const remover = await host.create('Remover')
  expect((await worker.cli('status')).code).toBe(0)
  expect((await remover.cli('status')).code).toBe(0)
  const tree = await externalTree(ade, repo, 'shared')
  const repositoryId = await adopt(remover.asScratch(), repo.path, tree)

  const launch = await launchShell(worker.asScratch(), tree)
  expect(launch.launched).toBe(true)

  // Both profiles see the one claim, owned by the worker's profile ID.
  const seenByRemover = await claimsOn(remover.asScratch(), tree)
  expect(seenByRemover).toHaveLength(1)
  expect(seenByRemover[0]).toMatchObject({
    owner_profile: worker.id,
    mine: false,
    mode: 'shared',
    purpose: 'use',
    state: 'active',
    owner_live: true,
  })
  const seenByWorker = await claimsOn(worker.asScratch(), tree)
  expect(seenByWorker.map((claim) => [claim.id, claim.mine])).toEqual([[seenByRemover[0].id, true]])

  const refused = await removeTree(remover.asScratch(), repositoryId, 'remove-shared', tree)
  expect(refused).toMatchObject({ type: 'error', code: 'host_resource_conflict', recovery: 'inspect_host_resources' })
  expect(await isRunning(launch.shellPid!)).toBe(true)

  // The remover restarts: the conflict is still there for it, and the checkout and shell survive.
  await remover.stop()
  expect((await remover.cli('status')).code).toBe(0)
  const afterRestart = await claimsOn(remover.asScratch(), tree)
  expect(afterRestart.map((claim) => [claim.id, claim.owner_profile, claim.state, claim.mine])).toEqual([
    [seenByRemover[0].id, worker.id, 'active', false],
  ])
  const refusedAgain = await removeTree(remover.asScratch(), repositoryId, 'remove-shared-2', tree)
  expect(refusedAgain).toMatchObject({ type: 'error', code: 'host_resource_conflict' })
  expect(await isRunning(launch.shellPid!)).toBe(true)
  expect(await exists(tree)).toBe(true)
})
