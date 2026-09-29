import { BrowserWindow } from 'electron'
import { handle } from '../ipc'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  dailyUseCommand,
  sameReviewAnchor,
  sameReviewFeedback,
  type DailyUseRequest,
  type DailyUseResponse,
  type ReviewAnchor,
  type ReviewFeedback,
} from '@ade/client'
import { SendJournal, type SendIntent } from '@ade/client/journals'
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
import { activeReviewContext, assertReviewContext, reviewBatchPrompt, reviewPrompt } from '../review'
import type { DraftState, SendPending } from '../../shared/bridge/conversations'
import { conversationOperations, isAllowedOperation } from '../../shared/bridge/operations'
import { validId } from '../validation'
import { selectedWorkspace } from '../windows'
import {
  beginSend,
  daemon,
  dispatchSend,
  draftKey,
  drafts,
  flushDraft,
  loadDraft,
  pendingSend,
  pipeline,
  reviewSelections,
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

/** The reply for a prompt still being delivered. Called only while the entry holds a send. */
function sendPending(entry: DraftEntry): SendPending {
  const pending = pendingSend(entry)
  if (!pending) throw new Error('No prompt is awaiting confirmation')
  return { type: 'send_pending', ...pending }
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
        if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 120 * 1024) throw new Error('Invalid draft')
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
      try {
        if (args.review_anchor !== undefined && args.review_feedback !== undefined)
          throw new Error('Choose one review feedback format')
        const reviewWorkspaceId =
          args.review_feedback === undefined
            ? (args.review_anchor as Record<string, unknown> | null)?.workspace_id
            : (args.review_feedback as Record<string, unknown> | null)?.workspace_id
        const reviewContext =
          args.review_anchor === undefined && args.review_feedback === undefined
            ? null
            : activeReviewContext(event.sender.id, reviewWorkspaceId)
        let text = args.text
        let reviewFeedback: ReviewFeedback | undefined
        if (op === 'agent.send' && reviewContext) {
          if (args.review_feedback !== undefined) {
            const prepared = await reviewBatchPrompt(reviewContext, args.conversation_id, args.review_feedback)
            text = prepared.text
            reviewFeedback = prepared.feedback
          } else {
            text = await reviewPrompt(reviewContext, args.conversation_id, args.review_anchor, args.note)
          }
          assertReviewContext(reviewContext, reviewWorkspaceId as string, args.conversation_id)
        }
        const entry = await loadDraft(event.sender.id, endpoint, args.conversation_id)
        if (op === 'agent.retry_send') {
          if (!entry.send) throw new Error('No prompt is awaiting confirmation')
          if (args.request_id !== undefined && args.request_id !== entry.send.requestId) {
            throw new Error('A different prompt is awaiting confirmation')
          }
          const review = reviewSelections.get(entry.send)
          if (review) {
            const selection = selectedWorkspace(event.sender.id)
            if (
              !selection ||
              selection.workspaceId !== review.workspaceId ||
              selection.conversationId !== review.conversationId ||
              selection.generation !== getClientGeneration()
            )
              throw new Error('Return to the feedback workspace before retrying')
            review.epoch = selection.epoch
          } else if (entry.send.reviewAnchor || entry.send.reviewFeedback) {
            // The branch guarantees one of the two is set.
            const workspaceId =
              entry.send.reviewAnchor?.workspace_id ?? (entry.send.reviewFeedback?.workspace_id as string)
            const context = activeReviewContext(event.sender.id, workspaceId)
            assertReviewContext(context, workspaceId, args.conversation_id)
            reviewSelections.set(entry.send, {
              senderId: event.sender.id,
              workspaceId,
              conversationId: args.conversation_id,
              epoch: context.epoch,
            })
          }
          if (entry.send.preparing) return sendPending(entry)
          return await dispatchSend(entry, entry.send)
        }
        if (
          !validId(args.request_id) ||
          typeof text !== 'string' ||
          !text.trim() ||
          Buffer.byteLength(text) > 120 * 1024
        ) {
          throw new Error('Invalid prompt')
        }
        if (
          reviewContext &&
          (entry.draft.text.length || (Array.isArray(entry.draft.attachments) && entry.draft.attachments.length))
        ) {
          throw new Error('Send or clear the ordinary conversation draft before sending review feedback')
        }
        if (entry.send) {
          if (entry.send.requestId !== args.request_id || entry.send.text !== text) {
            throw new Error('Resolve the previous prompt before starting another')
          }
          if (!sameReviewAnchor(entry.send.reviewAnchor, args.review_anchor)) {
            throw new Error('Review selection changed before prompt reconciliation')
          }
          if (!sameReviewFeedback(entry.send.reviewFeedback, reviewFeedback)) {
            throw new Error('Review feedback changed before prompt reconciliation')
          }
          if (entry.send.preparing) return sendPending(entry)
          return await dispatchSend(entry, entry.send)
        }
        if (entry.unclearedText) throw new Error('Finish clearing the previous sent draft before sending again')
        if (reviewContext && entry.draft.revision === 0) {
          entry.draft = { text: '', revision: 1, attachments: [] }
        }
        if (reviewContext) assertReviewContext(reviewContext, reviewWorkspaceId as string, args.conversation_id)
        const intent: SendIntent = {
          requestId: args.request_id,
          text,
          draftText: entry.draft.text,
          revision: entry.draft.revision,
          attachments: entry.draft.attachments,
          state: 'pending',
          preparing: true,
          admitted: false,
          inFlight: null,
          reviewAnchor: reviewContext ? (args.review_anchor as ReviewAnchor) : undefined,
          reviewFeedback,
        }
        if (reviewContext) {
          reviewSelections.set(intent, {
            senderId: event.sender.id,
            workspaceId: reviewWorkspaceId as string,
            conversationId: args.conversation_id,
            epoch: reviewContext.epoch,
          })
        }
        return await beginSend(entry, intent)
      } catch (error) {
        if (op !== 'agent.send' || (args.review_anchor === undefined && args.review_feedback === undefined)) throw error
        const entry = drafts.get(draftKey(event.sender.id, endpoint, args.conversation_id))
        if (entry && entry.send?.requestId === args.request_id) {
          return sendPending(entry)
        }
        return { type: 'review_rejected', message: String(error) }
      }
    }
    if (!validId(args.request_id) || !['accept', 'decline', 'cancel', 'answer'].includes(String(args.decision)))
      throw new Error('Invalid answer')
    if (args.decision === 'answer') {
      if (
        !args.answers ||
        typeof args.answers !== 'object' ||
        Array.isArray(args.answers) ||
        Buffer.byteLength(JSON.stringify(args.answers)) > 64 * 1024
      )
        throw new Error('Invalid question answers')
    }
    return dailyUseCommand(endpoint, {
      op: 'agent.answer',
      conversation_id: args.conversation_id,
      request_id: args.request_id,
      decision: args.decision as DailyUseRequest<'agent.answer'>['decision'],
      ...(args.decision === 'answer' ? { answers: args.answers as DailyUseRequest<'agent.answer'>['answers'] } : {}),
    })
  })
}
