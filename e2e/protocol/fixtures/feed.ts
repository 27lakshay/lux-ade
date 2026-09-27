// A headless feed consumer: the SDK's AdeClient, with no React or Electron,
// subscribed to a profile's `session.subscribe` feed. It records every frame
// after the initial catalog so a spec can wait for one through the protocol.
import { expect } from '@playwright/test'
import { pathToFileURL } from 'node:url'
import type { AdeClient, ClientState, FeedFrame } from '../../../packages/client/dist/index.js'
import { binaries } from './environment'
import type { ScratchProfile } from './profile'

export type FeedConsumer = {
  client: AdeClient
  frames: FeedFrame[]
  states: ClientState[]
  /** Wait for a recorded frame that `match` accepts, and return it. */
  waitFor(match: (frame: FeedFrame) => boolean, timeout?: number): Promise<FeedFrame>
  /** Wait until the client reports `connected`. */
  connected(timeout?: number): Promise<void>
  stop(): void
}

type ClientModule = typeof import('../../../packages/client/dist/index.js')

/**
 * Start an AdeClient on the profile's socket. Call `stop()` before the test
 * ends; the client reconnects on its own until it is stopped.
 */
export async function subscribeFeed(profile: ScratchProfile): Promise<FeedConsumer> {
  const module = (await import(pathToFileURL(binaries.client).href)) as ClientModule
  const client = new module.AdeClient(profile.socket)
  const frames: FeedFrame[] = []
  const states: ClientState[] = []
  client.subscribe((state) => {
    states.push(state)
  })
  client.subscribeFeed((frame) => {
    frames.push(frame)
  })
  client.start()
  const consumer: FeedConsumer = {
    client,
    frames,
    states,
    async waitFor(match, timeout = 20_000) {
      let found: FeedFrame | undefined
      await expect
        .poll(
          () => {
            found = frames.find(match)
            return found !== undefined
          },
          { timeout },
        )
        .toBe(true)
      return found as FeedFrame
    },
    async connected(timeout = 20_000) {
      await expect.poll(() => client.getState().status, { timeout }).toBe('connected')
    },
    stop() {
      client.stop()
    },
  }
  return consumer
}
