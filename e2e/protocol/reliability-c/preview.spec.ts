// R016 at the daemon and protocol level: preview content stays separate from
// application authority. Arbitrary files are previewed as inert, bounded data
// that never leaves the workspace, and a browser owner's page content reaches
// clients only as data for the exact profile, owner and tab that was asked
// for. Tab records name the owner's browser storage profile: `fixed` for a
// fixed-socket owner registered as `fixed-<hash>`, and the profile ID itself
// for a managed profile. The Electron viewer itself (frames, popups, the
// renderer bridge) is for the UI phase.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type ScratchProfile } from '../fixtures'
import { fixedBrowserProfile, onePixelPng, ownerStorageProfile, startBrowserOwner, type BrowserOwnerCommand } from '../fixtures/browser-owner'
import { managedRuntimeHome } from '../fixtures/host-profiles'
import { rawReply } from '../fixtures/raw-reply'

const run = promisify(execFile)

const activePage = '<!doctype html><script>fetch("http://127.0.0.1/").then(()=>parent.postMessage("x","*"))</script><h1>page</h1>'
const frameInjection = 'line one\n{"type":"hello","pid":1}\n{"type":"error","message":"forged"}\n'

async function preview(profile: ScratchProfile, workspaceId: string, path: string) {
  return rawReply(profile, { op: 'file.preview', workspace_id: workspaceId, path }, 10_000)
}

test('file previews are inert, bounded and never leave the workspace or reach another profile', async ({ ade, profile, repo }) => {
  // Another profile on the host, with private data a preview must never read.
  const other = await ade.profile()
  const secret = join(other.home, 'secret.txt')
  await writeFile(secret, 'other profile secret\n')
  const { workspace } = await profile.call('workspace.open', { path: repo.path })

  // Active content is never returned in a renderable form.
  const files: Record<string, string | Buffer> = {
    'page.html': activePage, 'page.htm': activePage, 'image.svg': '<svg onload="alert(1)"/>',
    'doc.xhtml': activePage, 'feed.xml': '<x/>', 'fake.png': activePage, 'frames.txt': frameInjection,
    'binary.bin': Buffer.from([0x41, 0x00, 0x42]), 'pixel.png': onePixelPng,
    'large.txt': Buffer.alloc(300 * 1024, 'a'),
  }
  for (const [name, body] of Object.entries(files)) await writeFile(join(repo.path, name), body)
  for (const name of ['page.html', 'page.htm', 'image.svg', 'doc.xhtml', 'feed.xml', 'fake.png', 'binary.bin']) {
    const reply = await preview(profile, workspace.id, name)
    expect(reply, name).toMatchObject({ type: 'file_preview', path: name, kind: 'unsupported' })
    expect(reply.text, name).toBeUndefined()
    expect(reply.bytes_base64, name).toBeUndefined()
    expect(reply.mime, name).toBeUndefined()
  }
  // Text that looks like protocol frames is returned as one field of one frame, byte for byte.
  expect(await preview(profile, workspace.id, 'frames.txt'))
    .toMatchObject({ type: 'file_preview', kind: 'text', mime: 'text/plain', text: frameInjection, truncated: false })
  // A real image is returned only as a complete, validated image.
  expect(await preview(profile, workspace.id, 'pixel.png')).toMatchObject({ kind: 'image', mime: 'image/png',
    bytes_base64: onePixelPng.toString('base64') })
  // A large file is bounded at 256 KiB.
  const large = await preview(profile, workspace.id, 'large.txt')
  expect(large).toMatchObject({ kind: 'text', size: 300 * 1024, truncated: true })
  expect(String(large.text).length).toBe(256 * 1024)

  // Links out of the workspace, into another profile, are never followed.
  await symlink(secret, join(repo.path, 'link-to-secret.txt'))
  await symlink(other.home, join(repo.path, 'link-to-home'))
  await symlink(join(other.dataDirectory, 'sessions.sqlite'), join(repo.path, 'link-to-db'))
  for (const path of ['link-to-secret.txt', 'link-to-home/secret.txt', 'link-to-db', '../repo-1/page.html',
    'nested/../../escape', `/${secret}`, secret, '']) {
    const reply = await preview(profile, workspace.id, path)
    expect(reply.type, path).toBe('error')
    expect(JSON.stringify(reply), path).not.toContain('other profile secret')
  }
  // A listing names a link as a link and never lists what it points at.
  const listing = await profile.call('file.list', { workspace_id: workspace.id })
  expect(listing.entries.find((entry) => entry.name === 'link-to-home')).toMatchObject({ kind: 'symlink', size: null })
  expect(listing.entries.find((entry) => entry.name === 'link-to-secret.txt')).toMatchObject({ kind: 'symlink' })
  const search = await profile.call('file.search', { workspace_id: workspace.id, query: 'secret' })
  expect(search.results.map((entry) => entry.path).sort()).toEqual(['link-to-secret.txt'])

  // A named pipe or a socket in the workspace fails at once instead of blocking the daemon.
  await run('mkfifo', [join(repo.path, 'pipe')])
  const pipe = await preview(profile, workspace.id, 'pipe')
  expect(pipe).toMatchObject({ type: 'error' })
  expect(pipe.message).toMatch(/regular file/)
  await expect(profile.call('catalog.get', {})).resolves.toMatchObject({ type: 'catalog' })

  // The other profile's daemon cannot be reached through this profile's workspace IDs.
  await expect(other.call('file.preview', { workspace_id: workspace.id, path: 'frames.txt' })).rejects.toThrow()
})

type Answer = (command: BrowserOwnerCommand) => Record<string, unknown>

/** A browser tab record as the owner reports it. Page-controlled fields carry adversarial text. */
function tab(profileId: string, id: string, extra: Record<string, unknown> = {}) {
  return { id, profileId, requestedUrl: 'https://example.invalid/', loading: false, error: '',
    observedUrl: 'https://example.invalid/#"},"type":"catalog"', title: `${frameInjection}</title><script>x()</script>`,
    ...extra }
}

test('browser page content reaches clients only as data for the exact profile, owner and tab asked for', async ({ ade, profile }) => {
  let answer: Answer = () => ({ type: 'error', message: 'unscripted' })
  const owner = await startBrowserOwner(profile, (command) => answer(command))
  const browserProfile = owner.profileId
  expect(browserProfile).toBe(fixedBrowserProfile(profile.socket))
  const inspect = (tabId: string, extra: Record<string, unknown> = {}) => rawReply(profile,
    { op: 'browser.inspect', profile_id: browserProfile, owner_id: owner.ownerId, tab_id: tabId, ...extra })
  const identity = (command: BrowserOwnerCommand) => ({ profile_id: command.profile_id, owner_id: command.owner_id })
  // Like the real fixed-socket owner, this one stores its tabs under `fixed`.
  const storage = ownerStorageProfile(browserProfile)
  expect(storage).toBe('fixed')

  // Adversarial page text is relayed as inert string fields of one typed reply.
  answer = (command) => ({ type: 'browser_tab', ...identity(command), tab_id: command.tab_id,
    tab: tab(storage, String(command.tab_id)) })
  const good = await inspect('tab-1')
  expect(good).toMatchObject({ type: 'browser_tab', tab_id: 'tab-1', tab: { id: 'tab-1', title: expect.stringContaining('<script>') } })
  // The daemon relays the owner only the fields of the request's own contract.
  expect(owner.commands.at(-1)).toEqual({ op: 'browser.inspect', profile_id: browserProfile, owner_id: owner.ownerId, tab_id: 'tab-1' })
  const relayed = owner.commands.length
  await inspect('tab-1', { socket_path: '/tmp/x', op2: 'workspace.remove' })
  for (const command of owner.commands.slice(relayed)) {
    expect(Object.keys(command).sort()).toEqual(['op', 'owner_id', 'profile_id', 'tab_id'])
  }

  // A reply for a popup or another tab than the one asked for is refused, never relayed as the requested tab.
  answer = (command) => ({ type: 'browser_tab', ...identity(command), tab_id: 'popup-7',
    tab: tab(storage, 'popup-7') })
  expect(await inspect('tab-1')).toMatchObject({ type: 'error', code: 'unavailable' })
  answer = (command) => ({ type: 'browser_tab', ...identity(command), tab_id: command.tab_id,
    tab: tab(storage, 'popup-7') })
  expect(await inspect('tab-1')).toMatchObject({ type: 'error', code: 'unavailable' })
  // A reply naming another profile or owner is refused.
  answer = (command) => ({ type: 'browser_tab', profile_id: 'fixed-other', owner_id: command.owner_id,
    tab_id: command.tab_id, tab: tab('fixed-other', String(command.tab_id)) })
  expect(await inspect('tab-1')).toMatchObject({ type: 'error', code: 'unavailable' })
  // A tab record from another browser storage profile is refused.
  answer = (command) => ({ type: 'browser_tab', ...identity(command), tab_id: command.tab_id,
    tab: tab('fixed-other', String(command.tab_id)) })
  expect(await inspect('tab-1')).toMatchObject({ type: 'error', code: 'unavailable' })
  answer = (command) => ({ type: 'browser_tabs', ...identity(command), profileId: storage, selectedId: 'tab-1',
    tabs: [tab(storage, 'tab-1'), tab('fixed-other', 'foreign-tab')] })
  expect(await rawReply(profile, { op: 'browser.list', profile_id: browserProfile, owner_id: owner.ownerId }))
    .toMatchObject({ type: 'error', code: 'unavailable' })
  // A reply outside the contract is refused.
  answer = (command) => ({ type: 'browser_tab', ...identity(command), tab_id: command.tab_id,
    tab: { id: command.tab_id, profileId: storage, title: 7 } })
  expect(await inspect('tab-1')).toMatchObject({ type: 'error', code: 'protocol' })

  // Another profile's daemon never answers for this browser profile, and cannot take over its owner.
  const other = await ade.profile()
  expect(await rawReply(other, { op: 'browser.list', profile_id: browserProfile, owner_id: owner.ownerId }))
    .toMatchObject({ type: 'error', code: 'unavailable' })
  expect(await rawReply(other, { op: 'browser.owner.register', profile_id: browserProfile, owner_id: 'intruder',
    socket_path: join(profile.root, 'bo', 'o.sock') })).toMatchObject({ type: 'error', code: 'unavailable' })

  // An owner endpoint that is not a private socket owned by this user is refused.
  const shared = join(ade.root, 'shared-bo')
  await mkdir(shared, { recursive: true })
  await chmod(shared, 0o755)
  const server: Server = createServer()
  await new Promise<void>((resolveListen) => server.listen(join(shared, 'o.sock'), () => resolveListen()))
  try {
    expect(await rawReply(profile, { op: 'browser.owner.register', profile_id: browserProfile, owner_id: 'shared',
      socket_path: join(shared, 'o.sock') })).toMatchObject({ type: 'error', code: 'invalid_request' })
    await symlink(join(profile.root, 'bo', 'o.sock'), join(profile.root, 'bo', 'alias.sock'))
    expect(await rawReply(profile, { op: 'browser.owner.register', profile_id: browserProfile, owner_id: 'alias',
      socket_path: join(profile.root, 'bo', 'alias.sock') })).toMatchObject({ type: 'error', code: 'invalid_request' })
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
  // The registered owner is unchanged and still serves this profile only.
  answer = (command) => ({ type: 'browser_tab', ...identity(command), tab_id: command.tab_id,
    tab: tab(storage, String(command.tab_id)) })
  expect(await inspect('tab-2')).toMatchObject({ type: 'browser_tab', owner_id: owner.ownerId, tab_id: 'tab-2' })
  await owner.close()
})

/** A scripted owner that answers `browser.list` and `browser.inspect` with one tab in the storage profile `storage()`. */
function tabsOwner(storage: () => string): Answer {
  return (command) => {
    const identity = { profile_id: command.profile_id, owner_id: command.owner_id }
    if (command.op === 'browser.list') {
      return { type: 'browser_tabs', ...identity, profileId: storage(), selectedId: 'tab-1', tabs: [tab(storage(), 'tab-1')] }
    }
    return { type: 'browser_tab', ...identity, tab_id: command.tab_id, tab: tab(storage(), String(command.tab_id)) }
  }
}

test('a fixed-socket owner reports tabs under its fixed storage profile, not the daemon profile ID', async ({ profile }) => {
  // The real Electron owner in fixed-socket mode registers as fixed-<hash> and
  // keeps every tab in the browser storage profile `fixed`.
  let storage = 'fixed'
  const owner = await startBrowserOwner(profile, tabsOwner(() => storage))
  expect(owner.profileId).toMatch(/^fixed-[0-9a-f]{32}$/)
  const request = { profile_id: owner.profileId, owner_id: owner.ownerId }
  expect(await rawReply(profile, { op: 'browser.list', ...request })).toMatchObject({ type: 'browser_tabs',
    profile_id: owner.profileId, profileId: 'fixed', tabs: [{ id: 'tab-1', profileId: 'fixed' }] })
  expect(await rawReply(profile, { op: 'browser.inspect', ...request, tab_id: 'tab-1' })).toMatchObject({
    type: 'browser_tab', profile_id: owner.profileId, tab_id: 'tab-1', tab: { profileId: 'fixed' } })
  // The daemon's own profile ID, or any other name, is not this owner's storage profile.
  for (const wrong of [owner.profileId, 'fixed-other', fixedBrowserProfile('/elsewhere.sock')]) {
    storage = wrong
    expect(await rawReply(profile, { op: 'browser.list', ...request }), wrong).toMatchObject({ type: 'error', code: 'unavailable' })
    expect(await rawReply(profile, { op: 'browser.inspect', ...request, tab_id: 'tab-1' }), wrong)
      .toMatchObject({ type: 'error', code: 'unavailable' })
  }
  await owner.close()
})

test('a managed profile owner reports tabs under the profile ID itself', async ({ ade }) => {
  const id = randomUUID()
  const runtimeHome = managedRuntimeHome(join(ade.root, 'host'), id)
  await mkdir(runtimeHome, { recursive: true, mode: 0o700 })
  const profile = await ade.profile({ env: { ADE_RUNTIME_HOME: runtimeHome } })
  let storage: string = id
  const owner = await startBrowserOwner(profile, tabsOwner(() => storage), 'e2e-owner', id)
  expect(ownerStorageProfile(id)).toBe(id)
  const request = { profile_id: id, owner_id: owner.ownerId }
  expect(await rawReply(profile, { op: 'browser.list', ...request })).toMatchObject({ type: 'browser_tabs',
    profile_id: id, profileId: id, tabs: [{ id: 'tab-1', profileId: id }] })
  expect(await rawReply(profile, { op: 'browser.inspect', ...request, tab_id: 'tab-1' })).toMatchObject({
    type: 'browser_tab', tab: { profileId: id } })
  // A managed owner never reports the fixed-socket storage profile.
  storage = 'fixed'
  expect(await rawReply(profile, { op: 'browser.list', ...request })).toMatchObject({ type: 'error', code: 'unavailable' })
  expect(await rawReply(profile, { op: 'browser.inspect', ...request, tab_id: 'tab-1' }))
    .toMatchObject({ type: 'error', code: 'unavailable' })
  await owner.close()
})
