import { BrowserWindow } from 'electron'
import { handle } from '../ipc'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { dailyUseCommand, type DailyUseCommand, type DailyUseRequest, type DailyUseResponse } from '@ade/client'
import { SendJournal } from '@ade/client/journals'
import { CONVERSATION_WINDOW } from '@ade/client/sync'
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
/** The draft.* reply: main's draft for this renderer view and Conversation. */
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
    if (
      (op === 'draft.get' ||
        op === 'draft.save' ||
        op === 'draft.flush' ||
        op === 'draft.stash.list' ||
        op === 'draft.stash.restore' ||
        op === 'agent.send' ||
        op === 'agent.retry_send') &&
      !validId(args.view_id)
    ) {
      throw new Error('Invalid conversation view ID')
    }
    if (op === 'draft.get' && endpoint && validId(args.conversation_id)) {
      const cached = drafts.get(draftKey(event.sender.id, endpoint, args.conversation_id, args.view_id as string))
      if (cached) return draftState(cached)
    }
    if (getClient().getState().status !== 'connected' || !endpoint) {
      throw new Error('Profile daemon is unavailable')
    }
    const catalog = getClient().getState().catalog
    if (op === 'provider.list') return dailyUseCommand(endpoint, { op })
    if (op === 'provider.inspect' || op === 'provider.readiness') {
      const pending = dailyUseCommand(endpoint, {
        ...(args as Record<string, unknown>),
        op,
      } as unknown as DailyUseRequest<typeof op>) as Promise<
        DailyUseResponse<'provider.inspect' | 'provider.readiness'>
      >
      const result = await pending
      if (getClientGeneration() !== generation || getSocket() !== endpoint) {
        throw new Error('Profile changed during provider request; inspect the original profile before retrying')
      }
      return result
    }
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
    if (op === 'draft.stash.list' || op === 'draft.stash.restore') {
      const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id, args.view_id as string)
      if (op === 'draft.stash.list') {
        return { type: 'draft_stashes', stashes: await pipeline().listDraftStashes(entry) }
      }
      if (typeof args.name !== 'string' || !Number.isSafeInteger(args.stash_revision)) {
        throw new Error('Invalid draft recovery selection')
      }
      await pipeline().restoreDraftStash(entry, args.name, args.stash_revision as number)
      return draftState(entry)
    }
    if (op === 'draft.get' || op === 'draft.save' || op === 'draft.flush') {
      const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id, args.view_id as string)
      if (op === 'draft.save') {
        if (entry.unclearedText || entry.send || entry.recoveryPending)
          throw new Error('Resolve the previous prompt before editing this draft')
        // The daemon's `draft.save` holds the size limit.
        if (typeof args.text !== 'string') throw new Error('Invalid draft')
        entry.draft = { ...entry.draft, text: args.text, revision: entry.draft.revision + 1 }
        pipeline().schedule(entry)
      }
      if (op === 'draft.flush') {
        await flushDraft(entry)
        entry.unclearedText = ''
      }
      return draftState(entry)
    }
    if (op === 'conversation.history') {
      const result = await dailyUseCommand(endpoint, {
        ...(args as Record<string, unknown>),
        op,
      } as unknown as DailyUseRequest<'conversation.history'>)
      if (getClientGeneration() !== generation || getSocket() !== endpoint) {
        throw new Error('Profile changed during native history read; refresh the conversation before retrying')
      }
      return result
    }
    if (op === 'conversation.get') {
      const request = {
        ...(args as Record<string, unknown>),
        op,
        limit: args.limit === undefined ? CONVERSATION_WINDOW : args.limit,
      } as unknown as DailyUseCommand<'conversation.get'>
      return dailyUseCommand(endpoint, request)
    }
    if (op === 'agent.cancel') {
      const operationId = args.operation_id
      const sourceAttemptId = args.source_attempt_id
      const submissionId = args.submission_id
      const turnId = args.turn_id
      if (
        typeof operationId !== 'string' ||
        !operationId ||
        typeof sourceAttemptId !== 'string' ||
        !sourceAttemptId ||
        typeof submissionId !== 'string' ||
        !submissionId ||
        (turnId !== undefined && (typeof turnId !== 'string' || !turnId))
      ) {
        throw new Error('Cancellation target is missing or invalid; refresh the active turn before retrying')
      }
      const result = await dailyUseCommand(endpoint, {
        op,
        conversation_id: args.conversation_id as string,
        source_attempt_id: sourceAttemptId,
        submission_id: submissionId,
        ...(turnId === undefined ? {} : { turn_id: turnId }),
        operation_id: operationId,
      })
      if (getClientGeneration() !== generation || getSocket() !== endpoint) {
        throw new Error('Profile changed during agent request; inspect the original profile before retrying')
      }
      return result
    }
    if (op === 'agent.resume') {
      const result = await dailyUseCommand(endpoint, { op, conversation_id: args.conversation_id as string })
      if (getClientGeneration() !== generation || getSocket() !== endpoint) {
        throw new Error('Profile changed during agent request; inspect the original profile before retrying')
      }
      return result
    }
    if (op === 'agent.send' || op === 'agent.retry_send') {
      // The SDK's send pipeline holds the rules: one prompt per window and Conversation at a time,
      // and a retry names the prompt awaiting confirmation. Review feedback is its own daemon
      // command (`review.feedback.send`, main/review.ts).
      const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id, args.view_id as string)
      return op === 'agent.retry_send'
        ? await pipeline().retry(entry, args.request_id as string | undefined)
        : await pipeline().send(entry, args.request_id as string, args.text as string)
    }
    // The daemon validates the answer against the exact pending-request revision.
    return dailyUseCommand(endpoint, {
      op: 'agent.answer',
      conversation_id: args.conversation_id as string,
      request_id: args.request_id as string,
      request_revision: args.request_revision as number,
      source_attempt_id: args.source_attempt_id as string,
      operation_id: args.operation_id as string,
      answer: args.answer as DailyUseRequest<'agent.answer'>['answer'],
    })
  })
}
