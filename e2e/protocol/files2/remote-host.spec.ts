// F071 and F073 on a remote execution host: a workspace that lives on another
// machine is browsed, searched and previewed by that host's own daemon, over
// the pinned SSH transport and through `ade remote request`. Symbolic links,
// traversal, unreadable folders, changed paths, active content, a link loss
// and a remote daemon restart behave there as they do locally, and nothing
// about the workspace reaches the local profile.
import { chmod, mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, remoteCall, test, type RemoteTarget } from '../fixtures/remote-hosts'
import { isRunning } from '../fixtures'
import { startedHost, targetOf } from '../remote/steps'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
  'base64',
)

function targetArgs(target: RemoteTarget): string[] {
  return [
    '--host',
    target.hostId,
    '--remote-profile',
    target.profileId,
    '--ssh',
    target.destination,
    '--remote-socket',
    target.remoteSocket,
    '--host-key',
    target.hostPublicKey!,
    '--timeout-ms',
    '15000',
  ]
}

type Entry = { name: string; path: string; kind: string; size: number | null }

test('browse, search and preview run on the remote execution host with its own path safety and limits', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const target = targetOf(started)
  const repo = await started.host.repo('app', {
    'README.md': '# Remote app\n',
    'src/lib/Main.rs': 'fn main() {}\n',
    'docs/readme-extra.md': 'extra\n',
  })
  for (let index = 0; index < 150; index++)
    await repo.write(`gen/item-${String(index).padStart(3, '0')}.txt`, `${index}\n`)
  await writeFile(join(repo.path, 'pixel.png'), png)
  await writeFile(join(repo.path, 'page.html'), '<script>window.ade.bridge.run()</script>')
  await writeFile(join(started.host.home, 'host-secret.txt'), 'host secret\n')
  await symlink(join(started.host.home, 'host-secret.txt'), join(repo.path, 'secret-link'))
  await mkdir(join(repo.path, 'locked', 'readme-hidden'), { recursive: true })
  await chmod(join(repo.path, 'locked'), 0o000)

  try {
    const opened = await profile.cli(
      'remote',
      'request',
      'workspace.open',
      JSON.stringify({ path: repo.path }),
      ...targetArgs(target),
    )
    expect(opened.code, opened.stderr).toBe(0)
    const workspace_id = (opened.json?.workspace as { id: string }).id
    const transport = await remote.transport(target)
    transport.start()
    await transport.waitUntilConnected(15_000)

    // Bounded pages with single-use cursors, served by the host's daemon.
    const listed: Entry[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: { entries: unknown[]; next_cursor: string | null } = await remoteCall(transport, 'file.list', {
        workspace_id,
        path: 'gen',
        limit: 60,
        ...(cursor ? { cursor } : {}),
      })
      expect(page.entries.length).toBeLessThanOrEqual(60)
      listed.push(...(page.entries as Entry[]))
      if (cursor)
        await expect(remoteCall(transport, 'file.list', { workspace_id, path: 'gen', cursor })).rejects.toThrow(
          /expired or was already used/,
        )
      cursor = page.next_cursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(new Set(listed.map((entry) => entry.path)).size).toBe(150)
    expect(listed.find((entry) => entry.name === 'item-007.txt')).toMatchObject({
      path: 'gen/item-007.txt',
      kind: 'file',
      size: 2,
    })

    // The symbolic link to a file elsewhere on the host is listed, never followed.
    const root = await remoteCall(transport, 'file.list', { workspace_id })
    expect(root.entries.find((entry) => entry.name === 'secret-link')).toMatchObject({ kind: 'symlink', size: null })
    await expect(remoteCall(transport, 'file.preview', { workspace_id, path: 'secret-link' })).rejects.toThrow()
    for (const path of ['../app', '/etc', 'src/../../app']) {
      await expect(remoteCall(transport, 'file.list', { workspace_id, path }), path).rejects.toThrow(
        /relative without parent traversal/,
      )
    }

    // Search is case-insensitive at any depth; the unreadable folder is skipped and reported.
    const search = await remoteCall(transport, 'file.search', { workspace_id, query: 'README' })
    expect(search.results.map((entry) => entry.path).sort()).toEqual(['README.md', 'docs/readme-extra.md'])
    expect(search.incomplete).toBe(true)
    await expect(remoteCall(transport, 'file.list', { workspace_id, path: 'locked' })).rejects.toThrow(
      /Permission denied/,
    )
    const cli = await profile.cli(
      'remote',
      'request',
      'file.search',
      JSON.stringify({ workspace_id, query: 'main.rs' }),
      ...targetArgs(target),
    )
    expect(cli.code, cli.stderr).toBe(0)
    expect(cli.json).toMatchObject({
      type: 'file_search',
      results: [{ name: 'Main.rs', path: 'src/lib/Main.rs', kind: 'file' }],
    })

    // Previews: text, a whole image, and active content that is never returned.
    expect(await remoteCall(transport, 'file.preview', { workspace_id, path: 'README.md' })).toMatchObject({
      kind: 'text',
      mime: 'text/plain',
      text: '# Remote app\n',
      truncated: false,
    })
    const image = await remoteCall(transport, 'file.preview', { workspace_id, path: 'pixel.png' })
    expect(image).toMatchObject({ kind: 'image', mime: 'image/png', size: png.length })
    expect(Buffer.from(image.bytes_base64!, 'base64').equals(png)).toBe(true)
    const html = await profile.cli(
      'remote',
      'request',
      'file.preview',
      JSON.stringify({ workspace_id, path: 'page.html' }),
      ...targetArgs(target),
    )
    expect(html.code, html.stderr).toBe(0)
    expect(html.json).toEqual({
      type: 'file_preview',
      path: 'page.html',
      kind: 'unsupported',
      size: 40,
      truncated: false,
    })

    // A folder renamed between pages invalidates its cursor on the host.
    const first = await remoteCall(transport, 'file.list', { workspace_id, path: 'gen', limit: 10 })
    await rename(join(repo.path, 'gen'), join(repo.path, 'generated'))
    await expect(
      remoteCall(transport, 'file.list', { workspace_id, path: 'gen', cursor: first.next_cursor! }),
    ).rejects.toThrow(/changed/)

    // The local profile knows nothing of the workspace and cannot use the host's cursor.
    const local = await profile.call('catalog.get', {})
    expect(JSON.stringify(local.catalog)).not.toContain(workspace_id)
    expect(JSON.stringify(local.catalog)).not.toContain(repo.path)
    const hostCursor = (await remoteCall(transport, 'file.list', { workspace_id, path: 'generated', limit: 10 }))
      .next_cursor!
    await expect(profile.call('file.list', { workspace_id, path: 'generated', cursor: hostCursor })).rejects.toThrow()
  } finally {
    await chmod(join(repo.path, 'locked'), 0o755)
  }
})

test('a link loss refuses file requests unsent, and a remote daemon restart expires its cursors', async ({
  remote,
}) => {
  const profile = await remote.profile()
  const started = await startedHost(remote, profile, 'devbox')
  const repo = await started.host.repo('app')
  for (let index = 0; index < 30; index++) await repo.write(`item-${String(index).padStart(2, '0')}.txt`, `${index}\n`)
  const transport = await remote.transport(targetOf(started))
  transport.start()
  await transport.waitUntilConnected(15_000)
  const { workspace } = await remoteCall(transport, 'workspace.open', { path: repo.path })
  const workspace_id = workspace.id

  // Link loss: requests are refused unsent and the local daemon answers none of them.
  const first = await remoteCall(transport, 'file.list', { workspace_id, limit: 10 })
  await started.host.linkDown()
  await expect.poll(() => transport.getState().phase).not.toBe('connected')
  await expect(remoteCall(transport, 'file.list', { workspace_id, cursor: first.next_cursor! })).rejects.toMatchObject({
    code: 'unavailable',
    delivery: 'not_sent',
  })
  await expect(remoteCall(transport, 'file.search', { workspace_id, query: 'item' })).rejects.toMatchObject({
    code: 'unavailable',
    delivery: 'not_sent',
  })

  // After reconnecting to the same daemon, the unsent cursor still continues the listing exactly once.
  await started.host.linkUp()
  await expect.poll(() => transport.getState().phase, { timeout: 30_000 }).toBe('connected')
  const rest: string[] = []
  let cursor: string | null = first.next_cursor
  while (cursor) {
    const page: { entries: Entry[]; next_cursor: string | null } = await remoteCall(transport, 'file.list', {
      workspace_id,
      limit: 10,
      cursor,
    })
    rest.push(...page.entries.map((entry) => entry.name))
    cursor = page.next_cursor
  }
  const names = [...first.entries.map((entry) => entry.name), ...rest]
  expect(new Set(names).size).toBe(names.length)
  expect(names.filter((name) => name.startsWith('item-'))).toHaveLength(30)

  // A remote daemon crash and restart: the old cursor is expired, a fresh listing works.
  const beforeCrash = await remoteCall(transport, 'file.search', { workspace_id, query: 'item', limit: 5 })
  expect(beforeCrash.next_cursor).not.toBeNull()
  process.kill(started.daemon.pid, 'SIGKILL')
  await expect.poll(() => isRunning(started.daemon.pid)).toBe(false)
  // The forward is up but the daemon behind it is gone: the page is lost, never answered locally.
  await expect(remoteCall(transport, 'file.search', { workspace_id, query: 'item', limit: 5 })).rejects.toMatchObject({
    code: 'unavailable',
  })
  const restarted = await profile.call(
    'remote.host.start',
    { host_id: 'devbox', operation_id: `e2e-files2-restart-${process.pid}-${Date.now()}` },
    { timeoutMs: 120_000 },
  )
  expect(restarted.outcome).toBe('running')
  await expect.poll(() => transport.getState().current?.bootId, { timeout: 30_000 }).toBe(restarted.daemon!.boot_id)
  await expect(
    remoteCall(transport, 'file.search', { workspace_id, query: 'item', cursor: beforeCrash.next_cursor! }),
  ).rejects.toThrow(/expired or was already used/)
  const fresh = await remoteCall(transport, 'file.search', { workspace_id, query: 'item', limit: 100 })
  expect(fresh.results).toHaveLength(30)
})
