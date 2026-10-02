// Helpers shared by the context-controls specs: what each mock provider
// received for a prompt, and small request builders. Every wait polls.
import { createHash } from 'node:crypto'
import { expect, type ScratchProfile } from '../fixtures'

export type Attachment = { id: string; name: string; media_type: string; size: number }

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The Codex `UserInput` items of every `turn/start` the mock received, oldest first. */
export async function codexInputs(profile: ScratchProfile): Promise<Array<Array<Record<string, string>>>> {
  return (await profile.mockCalls('codex'))
    .filter((call) => call.method === 'turn/start')
    .map((call) => (call.params as { input: Array<Record<string, string>> }).input)
}

/**
 * What the Claude SDK mock received as each user message's native content, oldest first.
 * A prompt that is a single text block is given as its text.
 */
export async function claudeContents(profile: ScratchProfile): Promise<unknown[]> {
  return (await profile.mockCalls('claude'))
    .filter((call) => call.method === 'send')
    .map((call) => {
      const content = call.content as Array<{ type: string; text?: string }>
      return content.length === 1 && content[0].type === 'text' ? content[0].text : content
    })
}

/** Wait for `count` native prompts on `provider` and return them. */
export async function waitForPrompts(
  profile: ScratchProfile,
  provider: 'codex' | 'claude',
  count: number,
): Promise<unknown[]> {
  let prompts: unknown[] = []
  await expect
    .poll(async () => {
      prompts = provider === 'codex' ? await codexInputs(profile) : await claudeContents(profile)
      return prompts.length
    })
    .toBe(count)
  return prompts
}

export async function snapshot(profile: ScratchProfile, conversationId: string) {
  return profile.call('conversation.get', { conversation_id: conversationId })
}

/** A PNG of exactly `size` bytes: a valid signature, then zero padding. */
export function pngOfSize(size: number): Buffer {
  const png = Buffer.alloc(size)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
  return png
}
