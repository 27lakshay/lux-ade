import { isDeepStrictEqual } from 'node:util'
import { loadAliases, saveAliases } from './identity.mjs'

const fail = (code, message) => {
  throw { code, message }
}
const prompt = (message) =>
  message.type === 'user' &&
  !message.parent_tool_use_id &&
  (typeof message.message?.content === 'string' ||
    message.message?.content?.some((block) => ['text', 'image', 'document'].includes(block.type)))
async function readChain(sdk, session) {
  const messages = []
  let bytes = 0
  for (let offset = 0; offset <= 2000;) {
    const page = await sdk.getSessionMessages(session, { dir: process.cwd(), offset, limit: 32 })
    if (!page.length) return messages
    for (const message of page) {
      bytes += Buffer.byteLength(JSON.stringify(message))
      if (messages.length >= 2000 || bytes > 12 * 1024 * 1024)
        fail('resource_limit', 'Claude rewind history exceeds admission limits; original session retained')
      if (message.session_id !== session)
        fail('provider_failure', 'Claude rewind history returned another native session')
      messages.push(message)
      offset++
    }
  }
}
async function checkFork(sdk, options) {
  const query = sdk.query({ prompt: (async function* () {})(), options })
  let refusal = null
  const reading = (async () => {
    try {
      for await (const message of query)
        if (
          message.type === 'result' &&
          (message.is_error || String(message.result ?? '').startsWith('Resume rejected'))
        )
          refusal = message.errors?.join('; ') || message.result || 'Native fork was refused'
    } catch (error) {
      refusal ??= error.message
    }
  })()
  try {
    await query.initializationResult()
    await new Promise((resolve) => setImmediate(resolve))
  } catch (error) {
    refusal ??= error.message
  } finally {
    query.close()
    await reading
  }
  if (refusal) fail('provider_failure', 'Claude refused the conversation rewind; original session retained: ' + refusal)
}
export async function forkBefore(sdk, session, locator, options, previousAliases = loadAliases(session)) {
  if (locator?.provider !== 'claude' || locator.session !== session || typeof locator.message_id !== 'string')
    fail('invalid_request', 'Claude rewind requires an exact native prompt locator')
  const source = await sdk.getSessionInfo(session, { dir: process.cwd() })
  if (source?.sessionId !== session) fail('provider_failure', 'Claude rewind source session was not found')
  const all = await readChain(sdk, session)
  const chain = all.filter((message) => !message.parent_tool_use_id)
  const index = chain.findIndex((message) => message.uuid === locator.message_id)
  if (index < 0 || !prompt(chain[index]))
    fail('invalid_request', 'Claude history has no such native prompt; original session retained')
  if (index === 0) fail('unsupported', 'Claude cannot fork before its first message; original session retained')
  const at = chain[index - 1].uuid
  if (!chain.slice(index + 1).some(prompt))
    await checkFork(sdk, {
      ...options,
      resume: session,
      forkSession: true,
      resumeSessionAt: at,
      resumeDropsTurn: locator.message_id,
    })
  const current = await sdk.getSessionInfo(session, { dir: process.cwd() })
  if (current?.lastModified !== source.lastModified || current?.fileSize !== source.fileSize)
    fail('invalid_request', 'Claude native source changed while preparing rewind')
  const { sessionId: forked } = await sdk.forkSession(session, { dir: process.cwd(), upToMessageId: at })
  if (typeof forked !== 'string' || forked === session)
    fail('provider_failure', 'Claude fork did not return a new native session')
  const copied = await readChain(sdk, forked)
  const retained = all.slice(0, all.findIndex((message) => message.uuid === at) + 1)
  if (
    copied.length !== retained.length ||
    copied.some(
      (message, index) =>
        message.type !== retained[index].type || !isDeepStrictEqual(message.message, retained[index].message),
    )
  ) {
    await sdk.deleteSession(forked, { dir: process.cwd() })
    fail('provider_failure', 'Claude fork did not preserve earlier history in order; original session retained')
  }
  const aliases = new Map(
    copied.map((message, index) => [message.uuid, previousAliases.get(retained[index].uuid) ?? retained[index].uuid]),
  )
  saveAliases(forked, session, aliases)
  return { session: forked, previous_session: session, scope: 'conversation', aliases }
}
