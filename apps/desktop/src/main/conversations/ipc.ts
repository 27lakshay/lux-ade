import { BrowserWindow } from 'electron'
import { handle } from '../ipc'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { dailyUseCommand, type DailyUseRequest, type DailyUseResponse } from '@ade/client'
import { SendJournal } from '@ade/client/journals'
import {
  getClient,
  getClientGeneration,
  getProfileState,
  getSocket,
  getStartupProfileSelection,
  isSwitching,
  journalProfileId,
  launcher,
  managedProfiles,
  setSwitching,
  type Profile,
} from '../profile-connection'
import type { DraftState } from '../../shared/bridge/conversations'
import { conversationOperations, isAllowedOperation } from '../../shared/bridge/operations'
import { validId } from '../validation'
import {
  daemon,
  draftKey,
  drafts,
  flushDraft,
  loadDraft,
  pendingSend,
  pipeline,
  windowIds,
  type DraftEntry,
} from './send-pipeline'

function sendTransferRequest(
  event: Electron.IpcMainInvokeEvent,
  id: unknown,
  location: unknown,
  active: boolean,
): { profile: Profile; location: string } {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    window.isDestroyed() ||
    event.senderFrame !== window.webContents.mainFrame ||
    !managedProfiles ||
    isSwitching() ||
    typeof id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(id) ||
    typeof location !== 'string' ||
    !isAbsolute(location) ||
    location.includes('\0') ||
    location.length > 4096
  ) {
    throw new Error('Invalid pending-send transfer request')
  }
  const profile = getProfileState().profiles.find((item) => item.id === id)
  if (!profile || (active ? getProfileState().activeId !== id : getProfileState().activeId === id)) {
    throw new Error('Pending-send profile does not match the transfer request')
  }
  return { profile, location }
}
/** The `draft.*` reply: main's draft for this window and conversation. */
function draftState(entry: DraftEntry): DraftState {
  return {
    type: 'draft',
    draft: entry.draft,
    error: entry.error,
    sent_text: entry.unclearedText,
    send_pending: pendingSend(entry),
  }
}

export function registerConversationIpc(): void {
  handle('ade:send-journal-export', async (event, id: unknown, destination: unknown) => {
    if (getStartupProfileSelection()) await getStartupProfileSelection()
    const request = sendTransferRequest(event, id, destination, true)
    setSwitching(true)
    try {
      return await pipeline().journal.exportProfile(request.profile.id, request.location)
    } finally {
      setSwitching(false)
    }
  })
  handle('ade:send-journal-import', async (event, bundle: unknown, sourceId: unknown, targetId: unknown) => {
    if (getStartupProfileSelection()) await getStartupProfileSelection()
    const request = sendTransferRequest(event, targetId, bundle, false)
    if (typeof sourceId !== 'string' || !/^[0-9a-f-]{36}$/.test(sourceId)) {
      throw new Error('Invalid pending-send source identity')
    }
    setSwitching(true)
    try {
      await SendJournal.inspectTransfer(request.location, sourceId)
      const started = await launcher('start', request.profile.id)
      if (started.type !== 'profile_started' || typeof started.socket !== 'string' || !isAbsolute(started.socket))
        throw new Error('Restored profile daemon is unavailable')
      return await pipeline().journal.importProfile(
        request.location,
        sourceId,
        request.profile.id,
        started.socket,
        (record) =>
          daemon(started.socket as string, 'draft.send.get', {
            conversation_id: record.conversationId,
            window_id: record.windowId,
          }),
      )
    } finally {
      setSwitching(false)
    }
  })
  // Pending prompts: the journal's unadmitted and restore-held records, plus, while
  // the profile daemon is reachable, every send it still holds for this window.
  // While it is unreachable only the journal can answer.
  handle('ade:pending-sends', async (event) => {
    const pending = (await pipeline().journal.list()).map((record) => ({
      profileId: record.profileId,
      conversationId: record.conversationId,
      requestId: record.requestId,
      text: record.text,
    }))
    const endpoint = getSocket()
    const windowId = windowIds.get(event.sender.id)
    const generation = getClientGeneration()
    if (!endpoint || !windowId || getClient().getState().status !== 'connected') return pending
    let profileId: string
    try {
      profileId = journalProfileId(endpoint)
    } catch {
      return pending
    }
    const sends = await pipeline().listWindowSends(endpoint, windowId)
    if (getClientGeneration() !== generation || getSocket() !== endpoint) {
      throw new Error('Profile changed while pending prompts were listed')
    }
    for (const send of sends) {
      if (pending.some((item) => item.requestId === send.intent.request_id)) continue
      pending.push({
        profileId,
        conversationId: send.intent.conversation_id,
        requestId: send.intent.request_id,
        text: send.intent.text,
      })
    }
    return pending
  })
  handle('ade:conversation-request', async (event, op: unknown, fields: unknown) => {
    if (
      !isAllowedOperation(conversationOperations, op) ||
      !fields ||
      typeof fields !== 'object' ||
      Array.isArray(fields)
    ) {
      throw new Error('Invalid conversation request')
    }
    const endpoint = getSocket()
    const generation = getClientGeneration()
    const args = fields as Record<string, unknown>
    if (op === 'draft.get' && endpoint && validId(args.conversation_id)) {
      const cached = drafts.get(draftKey(event.sender.id, endpoint, args.conversation_id))
      if (cached) return draftState(cached)
    }
    if (getClient().getState().status !== 'connected' || !endpoint) {
      throw new Error('Profile daemon is unavailable')
    }
    const catalog = getClient().getState().catalog
    if (op === 'provider.list') return dailyUseCommand(endpoint, { op })
    if (
      op === 'account.list' ||
      op === 'account.create' ||
      op === 'account.inspect' ||
      op === 'account.verify' ||
      op === 'account.disable'
    ) {
      // Forwarded as they are: the SDK checks each request against its contract, and the daemon
      // checks the provider, the name, the generation and that the identity is the inspected one.
      const pending = dailyUseCommand(endpoint, {
        ...(args as Record<string, unknown>),
        op,
      } as unknown as DailyUseRequest<typeof op>) as Promise<
        DailyUseResponse<'account.list' | 'account.create' | 'account.inspect' | 'account.verify' | 'account.disable'>
      >
      const result = await pending
      if (getClientGeneration() !== generation || getSocket() !== endpoint) {
        throw new Error('Profile changed during account request; inspect the original profile before retrying')
      }
      return result
    }
    if (op === 'conversation.create') {
      // The daemon refuses an unknown workspace, provider or account, and a title over 256 bytes.
      const result = await daemon(endpoint, op, {
        operation_id: randomUUID(),
        workspace_id: args.workspace_id as string,
        provider: args.provider as string,
        title: args.title as string,
        ...(args.account_id === undefined ? {} : { account_id: args.account_id as string }),
      })
      if (getClientGeneration() !== generation || getSocket() !== endpoint)
        throw new Error('Profile changed during conversation creation')
      return result
    }
    if (!validId(args.conversation_id) || !catalog?.conversations.some((item) => item.id === args.conversation_id)) {
      throw new Error('Conversation is unavailable in this profile')
    }
    if (op === 'draft.get' || op === 'draft.save' || op === 'draft.flush') {
      const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id)
      if (op === 'draft.save') {
        if (entry.unclearedText || entry.send) throw new Error('Resolve the previous prompt before editing this draft')
        // The daemon's `draft.save` holds the size limit.
        if (typeof args.text !== 'string') throw new Error('Invalid draft')
        entry.draft = { text: args.text, revision: entry.draft.revision + 1, attachments: [] }
        pipeline().schedule(entry)
      }
      if (op === 'draft.flush') {
        await flushDraft(entry)
        entry.unclearedText = ''
      }
      return draftState(entry)
    }
    if (op === 'conversation.get')
      return dailyUseCommand(endpoint, { op, conversation_id: args.conversation_id, limit: 200 })
    if (op === 'agent.cancel' || op === 'agent.resume') {
      // The contract check rejects a non-string ID before it reaches the daemon.
      const conversationId = args.conversation_id
      const result =
        op === 'agent.cancel'
          ? await dailyUseCommand(endpoint, { op, conversation_id: conversationId })
          : await dailyUseCommand(endpoint, { op, conversation_id: conversationId })
      if (getClientGeneration() !== generation || getSocket() !== endpoint) {
        throw new Error('Profile changed during agent request; inspect the original profile before retrying')
      }
      return result
    }
    if (op === 'agent.send' || op === 'agent.retry_send') {
      // The SDK's send pipeline holds the rules: one prompt per window and Conversation at a time,
      // and a retry names the prompt awaiting confirmation. Review feedback is its own daemon
      // command (`review.feedback.send`, main/review.ts).
      const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id)
      return op === 'agent.retry_send'
        ? await pipeline().retry(entry, args.request_id as string | undefined)
        : await pipeline().send(entry, args.request_id as string, args.text as string)
    }
    // The daemon checks the decision and answers against the pending request.
    if (!validId(args.request_id)) throw new Error('Invalid answer')
    return dailyUseCommand(endpoint, {
      op: 'agent.answer',
      conversation_id: args.conversation_id,
      request_id: args.request_id,
      decision: args.decision as DailyUseRequest<'agent.answer'>['decision'],
      ...(args.decision === 'answer' ? { answers: args.answers as DailyUseRequest<'agent.answer'>['answers'] } : {}),
    })
  })
}
