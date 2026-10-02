import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Transcript } from './transcript.mjs'
import { loadAliases } from './identity.mjs'
import { toolOutput } from '../tool.mjs'

const fail = (code, message) => {
  throw { code, message }
}
export async function sessionSnapshot(sdk, session, context) {
  const info = await sdk.getSessionInfo(session, { dir: process.cwd() })
  if (info?.sessionId !== session) fail('provider_failure', 'Claude native history session was not found')
  return {
    ...context,
    session,
    consistency: 'best_effort',
    source:
      'claude-agent-sdk:' + resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) + ':' + process.cwd(),
    generation: JSON.stringify([info.lastModified, info.fileSize ?? null]),
    ...(info.lastModified === undefined ? {} : { modified_at_ms: info.lastModified }),
    ...(info.fileSize === undefined ? {} : { size_bytes: info.fileSize }),
  }
}
export async function historyPage(sdk, params, maxFrameBytes) {
  const snapshot = await sessionSnapshot(sdk, params.session, params.context)
  if (params.snapshot && !isDeepStrictEqual(params.snapshot, snapshot))
    fail('invalid_request', 'Claude native history changed; restart paging')
  let position = { offset: 0, item: 0, message: null }
  if (params.cursor) {
    try {
      position = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'))
    } catch {
      fail('invalid_request', 'Claude history cursor is invalid')
    }
    if (
      !Number.isSafeInteger(position.offset) ||
      position.offset < 0 ||
      position.offset > 2000 ||
      !Number.isSafeInteger(position.item) ||
      position.item < 0 ||
      position.generation !== snapshot.generation ||
      typeof position.message !== 'string'
    )
      fail('invalid_request', 'Claude history cursor does not match the native snapshot')
  }
  const frameOverhead = Buffer.byteLength(JSON.stringify(snapshot)) + 512
  const projection = new Transcript(params.session, loadAliases(params.session))
  const items = [],
    item_cursors = []
  let retained_bytes = 0,
    next_cursor = params.cursor,
    complete = false,
    error = null
  let cursorBytes = 0
  outer: for (let offset = 0; offset <= 2000;) {
    const messages = await sdk.getSessionMessages(params.session, { dir: process.cwd(), offset, limit: 32 })
    if (!messages.length) {
      complete = true
      next_cursor = null
      break
    }
    for (const message of messages) {
      if (offset >= 2000) fail('resource_limit', 'Claude history exceeds 2,000 native messages')
      if (message.session_id !== params.session)
        fail('provider_failure', 'Claude history returned another native session')
      if (position.message && offset === position.offset && message.uuid !== position.message)
        fail('invalid_request', 'Claude native history cursor moved')
      let index = 0
      for (const event of projection.project(message)) {
        const indexBefore = index++
        if (offset < position.offset || (offset === position.offset && indexBefore < position.item)) continue
        const bytes = Buffer.byteLength(JSON.stringify(event.item))
        const cursor = Buffer.from(
          JSON.stringify({ offset, item: index, message: message.uuid, generation: snapshot.generation }),
        ).toString('base64url')
        const encodedCursorBytes = Buffer.byteLength(JSON.stringify(cursor)) + 1
        if (
          items.length >= params.max_items ||
          retained_bytes + bytes > params.max_bytes ||
          frameOverhead + retained_bytes + bytes + cursorBytes + 2 * encodedCursorBytes + 2 * (items.length + 1) >
            maxFrameBytes
        ) {
          if (!items.length) {
            error = { code: 'resource_limit', message: 'Claude history item exceeds the requested byte window' }
            next_cursor = null
          }
          break outer
        }
        items.push(event.item)
        retained_bytes += bytes
        next_cursor = cursor
        cursorBytes += encodedCursorBytes
        item_cursors.push(cursor)
      }
      if (offset === position.offset && position.item > index)
        fail('invalid_request', 'Claude history cursor has no such item')
      offset++
    }
  }
  if (!isDeepStrictEqual(snapshot, await sessionSnapshot(sdk, params.session, params.context)))
    fail('invalid_request', 'Claude native history changed while paging')
  return { items, item_cursors, complete, next_cursor, retained_bytes, snapshot, error }
}
export async function childTranscript(sdk, params, limits) {
  if (
    !/^[a-zA-Z0-9_-]{1,256}$/.test(params.child) ||
    !Number.isSafeInteger(params.offset) ||
    params.offset < 0 ||
    params.offset > 100000
  )
    fail('invalid_request', 'Invalid Claude child transcript locator')
  let position = { offset: params.offset, block: 0, message: null }
  if (params.cursor) {
    try {
      position = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'))
    } catch {
      fail('invalid_request', 'Claude child transcript cursor is invalid')
    }
    if (
      position.session !== params.session ||
      position.child !== params.child ||
      position.offset !== params.offset ||
      !Number.isSafeInteger(position.block) ||
      position.block < 0 ||
      typeof position.message !== 'string'
    )
      fail('invalid_request', 'Claude child transcript cursor belongs to another native source')
  }
  const options = { dir: process.cwd() }
  const children = await sdk.listSubagents(params.session, options)
  if (!children.includes(params.child))
    fail('invalid_request', 'Claude child transcript does not belong to this session')
  const messages = await sdk.getSubagentMessages(params.session, params.child, {
    ...options,
    offset: position.offset,
    limit: 51,
  })
  if (position.message && messages[0]?.uuid !== position.message)
    fail('invalid_request', 'Claude child transcript native cursor moved')
  const items = []
  let bytes = 0
  const maxItems = Math.min(32, limits.max_history_page_items)
  const maxBytes = Math.min(512 * 1024, limits.max_output_frame_bytes - 1024)
  const page = (offset, block, message) => ({
    type: 'child_transcript',
    child_id: params.child,
    items,
    next_offset: offset,
    next_cursor:
      offset === null
        ? null
        : Buffer.from(
            JSON.stringify({ session: params.session, child: params.child, offset, block, message }),
          ).toString('base64url'),
  })
  for (const [messageIndex, message] of messages.slice(0, 50).entries()) {
    const content = message.message?.content
    const blocks =
      typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    if (messageIndex === 0 && position.block > blocks.length)
      fail('invalid_request', 'Claude child transcript cursor has no such native block')
    for (const [index, block] of blocks.entries()) {
      if (messageIndex === 0 && index < position.block) continue
      let text
      if (block.type === 'text') text = block.text ?? ''
      else if (block.type === 'tool_use') text = block.name + '\n' + JSON.stringify(block.input ?? {}, null, 2)
      else if (block.type === 'tool_result') text = toolOutput(block.content)
      else if (block.type === 'image' || block.type === 'document') text = '[' + block.type + ' attachment]'
      else continue
      const item = { id: message.uuid + ':' + index, role: message.type, kind: block.type, text, turn: null }
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1
      if (items.length >= maxItems || bytes + itemBytes > maxBytes) {
        if (!items.length) fail('resource_limit', 'Claude child transcript item exceeds its declared byte window')
        return page(position.offset + messageIndex, index, message.uuid)
      }
      bytes += itemBytes
      items.push(item)
    }
  }
  return messages.length > 50 ? page(position.offset + 50, 0, messages[50].uuid) : page(null, 0, null)
}

export async function hydrateTranscript(sdk, session, transcript, receipts = null) {
  const source = await sdk.getSessionInfo(session, { dir: process.cwd() })
  if (source?.sessionId !== session) fail('provider_failure', 'Claude native resume history was not found')
  for (let offset = 0; offset <= 2000;) {
    const messages = await sdk.getSessionMessages(session, { dir: process.cwd(), offset, limit: 32 })
    if (!messages.length) break
    for (const message of messages) {
      if (offset >= 2000) fail('resource_limit', 'Claude resume exceeds 2,000 native messages')
      if (message.session_id !== session)
        fail('provider_failure', 'Claude resume history returned another native session')
      if (receipts && Array.isArray(message.message?.content))
        for (const block of message.message.content)
          if (block.type === 'tool_result' && receipts.has(block.tool_use_id))
            transcript.plans.remember(block.tool_use_id, receipts.get(block.tool_use_id))
      for (const event of transcript.project(message)) void event
      offset++
    }
  }
  const current = await sdk.getSessionInfo(session, { dir: process.cwd() })
  if (current?.lastModified !== source.lastModified || current?.fileSize !== source.fileSize)
    fail('invalid_request', 'Claude native history changed while restoring tool state')
}
