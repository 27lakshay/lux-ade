// A scripted browser owner. The daemon relays browser commands such as
// `browser.context.capture` to the Unix socket a browser owner registers; in
// the product that owner is Electron. This fixture listens on a private
// socket inside the test process, registers it with the daemon, and answers
// each relayed command with a scripted reply. It starts no process and opens
// no browser.
import { createHash } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { ScratchProfile } from './profile'

export type BrowserOwnerCommand = Record<string, unknown> & { op: string }

export type BrowserOwner = {
  profileId: string
  ownerId: string
  /** Every command the daemon relayed, oldest first. */
  commands: BrowserOwnerCommand[]
  /** Unregister from the daemon and stop listening. */
  close(): Promise<void>
}

/** The browser profile ID a daemon started on `socket` without a managed runtime home uses. */
export function fixedBrowserProfile(socket: string): string {
  return `fixed-${createHash('sha256').update(socket).digest('hex').slice(0, 32)}`
}

/**
 * The browser storage profile the desktop owner reports on its tab records
 * (`profileId`) for the ADE profile it registered as. A fixed-socket owner
 * registers as `fixed-<hash>` and stores every tab under `fixed`; a managed
 * profile's owner stores tabs under the profile's own ID. See
 * apps/desktop/src/main/index.ts and profiles.ts.
 */
export function ownerStorageProfile(profileId: string): string {
  return /^fixed-[0-9a-f]{32}$/.test(profileId) ? 'fixed' : profileId
}

/** A 1x1 PNG, for a capture's element screenshot. */
export const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** The reply a real owner gives to `browser.context.capture`: one bounded element of the page. */
export function contextCaptureReply(command: BrowserOwnerCommand, page: { url: string; title: string; html: string;
  text: string }): Record<string, unknown> {
  const screenshot = command.screenshot !== false
  return {
    type: 'browser_context_capture', profile_id: command.profile_id, owner_id: command.owner_id, tab_id: command.tab_id,
    url: page.url, title: page.title,
    element: { tag: 'H1', html: page.html, text: page.text, rect: { x: 8, y: 16, width: 320, height: 40 },
      styles: { color: 'rgb(0, 0, 0)', 'font-size': '32px' }, attributes: { class: 'headline' } },
    viewport: { width: 1280, height: 800, device_pixel_ratio: 2 },
    truncated: [],
    screenshot: screenshot ? { data: onePixelPng.toString('base64'), width: 1, height: 1 } : null,
    screenshot_unavailable: screenshot ? null : 'not_requested',
  }
}

/**
 * Listen on a private socket under the profile's root, register it as the
 * profile's browser owner, and answer each relayed command with `answer`.
 */
export async function startBrowserOwner(profile: ScratchProfile,
  answer: (command: BrowserOwnerCommand) => Record<string, unknown>,
  ownerId = 'e2e-owner', profileId = fixedBrowserProfile(profile.socket)): Promise<BrowserOwner> {
  const directory = join(profile.root, 'bo')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const socket = join(directory, 'o.sock')
  const commands: BrowserOwnerCommand[] = []
  const server: Server = createServer((peer) => {
    let buffered = ''
    peer.on('error', () => undefined)
    peer.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const end = buffered.indexOf('\n')
      if (end < 0) return
      const command = JSON.parse(buffered.slice(0, end)) as BrowserOwnerCommand
      buffered = buffered.slice(end + 1)
      commands.push(command)
      peer.end(`${JSON.stringify(answer(command))}\n`)
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(socket, () => resolveListen())
  })
  server.unref()
  await chmod(socket, 0o600)
  const registered = await profile.rpc({ op: 'browser.owner.register', profile_id: profileId, owner_id: ownerId,
    socket_path: socket })
  if (registered.type === 'error') {
    server.close()
    throw new Error(`The browser owner fixture could not register: ${JSON.stringify(registered)}`)
  }
  return {
    profileId,
    ownerId,
    commands,
    async close() {
      await profile.rpc({ op: 'browser.owner.unregister', profile_id: profileId, owner_id: ownerId }).catch(() => undefined)
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}
