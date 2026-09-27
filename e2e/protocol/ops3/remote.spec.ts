// F062 "clone into a selected host" and F132 "remote installation is
// explicit". A remote host runs its own profile daemon; the client selects it
// through the pinned SSH transport. A clone or a skill installation sent there
// lands on that host only: the local profile's catalog, HOME and folders are
// untouched, and nothing reaches the remote host unless the caller named it.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, remoteCall, test } from '../fixtures/remote-hosts'
import { treeSnapshot } from '../fixtures/tree'
import { startedHost, targetOf } from '../remote/steps'

test('F062: a clone sent to a selected remote host lands there, registers there, and replays there', async ({ ade, remote }) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'buildbox')
  const source = await started.host.repo('app-source', { 'README.md': '# Remote app\n' })
  const bare = join(started.host.root, 'remotes', 'app.git')
  await mkdir(join(started.host.root, 'remotes'), { recursive: true })
  await source.git('clone', '--quiet', '--bare', source.path, bare)
  const head = (await source.git('rev-parse', 'HEAD')).trim()

  const transport = await remote.transport(targetOf(started))
  transport.start()
  await transport.waitUntilConnected(15_000)
  const destination = join(started.host.home, 'projects', 'app')
  await mkdir(join(started.host.home, 'projects'), { recursive: true })
  const request = { operation_id: 'clone-on-host', url: pathToFileURL(bare).href, destination }
  const cloned = await remoteCall(transport, 'repository.clone', request)
  expect(cloned).toMatchObject({ outcome: 'registered', head, branch: 'main' })
  expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# Remote app\n')
  const remoteCatalog = await remoteCall(transport, 'catalog.get', {})
  expect(remoteCatalog.catalog.workspaces.map((workspace) => workspace.root)).toContain(cloned.workspace!.root)

  // The same operation replays on the host without cloning again.
  expect((await remoteCall(transport, 'repository.clone', request)).workspace?.id).toBe(cloned.workspace!.id)

  // The local profile holds none of it: no workspace, no folder.
  const local = await profile.call('catalog.get', {})
  expect(JSON.stringify(local.catalog)).not.toContain(destination)
  expect(JSON.stringify(local.catalog)).not.toContain(cloned.workspace!.id)
  await expect(stat(join(ade.root, 'projects'))).rejects.toThrow()
  await profile.call('placement.record', { host: { kind: 'remote', host_id: 'buildbox' },
    resource: { kind: 'workspace', workspace_id: cloned.workspace!.id } })
  expect((await profile.call('placement.resolve', { resource: { kind: 'workspace', workspace_id: cloned.workspace!.id } }))
    .placement).toMatchObject({ host: { kind: 'remote', host_id: 'buildbox' }, source: 'recorded' })
})

test('F132: a skill installed and placed on a remote host is written only there', async ({ remote }) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'skillbox')
  const source = join(started.host.home, 'sources', 'greet')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), '---\nname: greet\ndescription: Greets on the host.\n---\n\nGreet.\n')
  const localHome = await treeSnapshot(profile.home)

  const transport = await remote.transport(targetOf(started))
  transport.start()
  await transport.waitUntilConnected(15_000)
  const installed = await remoteCall(transport, 'skill.install', { operation_id: 'install-on-host', source_path: source })
  const placed = await remoteCall(transport, 'skill.place', { operation_id: 'place-on-host', name: 'greet',
    expected_content_hash: installed.skill.content_hash, provider: 'claude', scope: 'global' })
  expect(placed).toMatchObject({ outcome: 'created', path: join(started.host.home, '.claude/skills/greet') })
  expect(await readFile(join(started.host.home, '.claude/skills/greet/SKILL.md'), 'utf8')).toContain('Greets on the host.')

  // The local profile was never asked: its catalog is empty and its HOME unchanged.
  expect((await profile.call('skill.list', {})).skills).toEqual([])
  expect(await treeSnapshot(profile.home)).toEqual(localHome)
  // The local daemon cannot place what only the host installed.
  await expect(profile.call('skill.place', { operation_id: 'place-locally', name: 'greet',
    expected_content_hash: installed.skill.content_hash, provider: 'claude', scope: 'global' }))
    .rejects.toThrow(/No bundle of this name/)
  await expect(stat(join(profile.home, '.claude/skills/greet'))).rejects.toThrow()
})
