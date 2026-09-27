import { BrowserWindow, ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import { requestDaemon, type ReviewAnchor, type ReviewFeedback } from '@ade/client'
import { getClient, getClientGeneration, getProfileState, getSocket, getStartupProfileSelection, isSwitching,
  launcher, managedProfiles, setSwitching, type Profile } from '../profile-connection'
import { activeReviewContext, assertReviewContext, reviewBatchPrompt, reviewPrompt, sameReviewAnchor,
  sameReviewFeedback } from '../review'
import { SendJournal } from '../send-journal'
import { validId } from '../validation'
import { selectedWorkspaces } from '../workspaces'
import { daemon, dispatchSend, draftKey, drafts, e2ePauseAfterSendJournal, flushDraft, journal, journalIdentity, journalRecord,
  loadDraft, pendingSend, scheduleDraft, type SendIntent } from './send-pipeline'

function sendTransferRequest(event: Electron.IpcMainInvokeEvent, id: unknown, location: unknown,
  active: boolean): { profile: Profile; location: string } {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame ||
    !managedProfiles || isSwitching() || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) ||
    typeof location !== 'string' || !isAbsolute(location) || location.includes('\0') || location.length > 4096) {
    throw new Error('Invalid pending-send transfer request')
  }
  const profile = getProfileState().profiles.find((item) => item.id === id)
  if (!profile || (active ? getProfileState().activeId !== id : getProfileState().activeId === id)) {
    throw new Error('Pending-send profile does not match the transfer request')
  }
  return { profile, location }
}
const conversationOps = new Set(['provider.list', 'account.list', 'account.create', 'account.inspect', 'account.verify', 'account.disable', 'conversation.create', 'conversation.get', 'agent.send', 'agent.retry_send', 'agent.answer', 'agent.cancel', 'agent.resume', 'draft.get', 'draft.save', 'draft.flush'])
export function registerConversationIpc(): void {
  ipcMain.handle('ade:send-journal-export', async (event, id: unknown, destination: unknown) => {
    if (getStartupProfileSelection()) await getStartupProfileSelection()
    const request = sendTransferRequest(event, id, destination, true)
    setSwitching(true)
    try { return await journal().exportProfile(request.profile.id, request.location) }
    finally { setSwitching(false) }
  })
  ipcMain.handle('ade:send-journal-import', async (event, bundle: unknown, sourceId: unknown, targetId: unknown) => {
    if (getStartupProfileSelection()) await getStartupProfileSelection()
    const request = sendTransferRequest(event, targetId, bundle, false)
    if (typeof sourceId !== 'string' || !/^[0-9a-f-]{36}$/.test(sourceId)) {
      throw new Error('Invalid pending-send source identity')
    }
    setSwitching(true)
    try {
      await SendJournal.inspectTransfer(request.location, sourceId)
      const started = await launcher('start', request.profile.id)
      if (started.type !== 'profile_started' || typeof started.socket !== 'string' ||
        !isAbsolute(started.socket)) throw new Error('Restored profile daemon is unavailable')
      return await journal().importProfile(request.location, sourceId, request.profile.id, started.socket,
        (record) => daemon(started.socket as string, 'draft.send.get', {
          conversation_id: record.conversationId, window_id: record.windowId }))
    } finally { setSwitching(false) }
  })
  ipcMain.handle('ade:pending-sends', async () => (await journal().list()).map((record) => ({
    profileId: record.profileId, conversationId: record.conversationId,
    requestId: record.requestId, text: record.text,
  })))
  ipcMain.handle('ade:conversation-request', async (event, op: unknown, fields: unknown) => {
    if (typeof op !== 'string' || !conversationOps.has(op) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('Invalid conversation request')
    }
    const endpoint = getSocket()
    const generation = getClientGeneration()
    const args = fields as Record<string, unknown>
    if (op === 'draft.get' && endpoint && validId(args.conversation_id)) {
      const cached = drafts.get(draftKey(event.sender.id, endpoint, args.conversation_id))
      if (cached) return { type: 'draft', draft: cached.draft, error: cached.error, sent_text: cached.unclearedText,
        send_pending: pendingSend(cached) }
    }
    if (getClient().getState().status !== 'connected' || !endpoint) {
      throw new Error('Profile daemon is unavailable')
    }
    const catalog = getClient().getState().catalog
    if (op === 'provider.list') return requestDaemon(endpoint, op)
    if (op === 'account.list' || op === 'account.create' || op === 'account.inspect' || op === 'account.verify' || op === 'account.disable') {
      let request: Record<string, unknown> = {}
      if (op === 'account.create') {
        if (typeof args.provider !== 'string' || !['claude', 'codex', 'omp'].includes(args.provider) || typeof args.name !== 'string' || !args.name.trim() || args.name.length > 80) {
          throw new Error('Invalid managed account')
        }
        request = { provider: args.provider, name: args.name.trim() }
      } else if (op !== 'account.list') {
        if (!validId(args.account_id)) throw new Error('Invalid account')
        request = { account_id: args.account_id }
        if (op === 'account.verify') {
          if (!Number.isSafeInteger(args.expected_generation) || (args.expected_generation as number) < 0) {
            throw new Error('Invalid account generation')
          }
          const identity = args.expected_identity
          const expected = identity as Record<string, unknown> | null
          const claudeIdentity = expected && Object.keys(expected).sort().join(',') === 'api_provider,auth_method,email,org_id' &&
            expected.auth_method === 'claude.ai' && expected.api_provider === 'firstParty' &&
            typeof expected.email === 'string' && expected.email.length > 0 && expected.email.length <= 320 &&
            typeof expected.org_id === 'string' && expected.org_id.length > 0 && expected.org_id.length <= 256
          const codexIdentity = expected && Object.keys(expected).sort().join(',') === 'chatgpt_account_id,email' &&
            typeof expected.email === 'string' && expected.email.length > 0 && expected.email.length <= 320 &&
            typeof expected.chatgpt_account_id === 'string' && expected.chatgpt_account_id.length > 0 &&
            expected.chatgpt_account_id.length <= 256
          const ompIdentity = expected && Object.keys(expected).sort().join(',') ===
            'account_id,credential_id,credential_type,email,identity_key,org_id,provider' &&
            typeof expected.provider === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(expected.provider) &&
            Number.isSafeInteger(expected.credential_id) && (expected.credential_id as number) > 0 &&
            expected.credential_type === 'oauth' && typeof expected.identity_key === 'string' &&
            expected.identity_key.length > 0 && expected.identity_key.length <= 512 &&
            (expected.email === null || (typeof expected.email === 'string' && expected.email.length <= 320)) &&
            (expected.account_id === null || (typeof expected.account_id === 'string' && expected.account_id.length <= 320)) &&
            (expected.org_id === null || (typeof expected.org_id === 'string' && expected.org_id.length <= 320)) &&
            (Boolean(expected.email) || Boolean(expected.account_id))
          if (!identity || typeof identity !== 'object' || Array.isArray(identity) || (!claudeIdentity && !codexIdentity && !ompIdentity)) {
            throw new Error('Invalid inspected account identity')
          }
          request.expected_generation = args.expected_generation
          request.expected_identity = identity
        }
      }
      const result = await requestDaemon(endpoint, op, request)
      if (getClientGeneration() !== generation || getSocket() !== endpoint) {
        throw new Error('Profile changed during account request; inspect the original profile before retrying')
      }
      return result
    }
    if (op === 'conversation.create') {
      const providers = await requestDaemon(endpoint, 'provider.list')
      const available = Array.isArray(providers.providers) ? providers.providers : []
      if (!validId(args.workspace_id) || !catalog?.workspaces.some((item) => item.id === args.workspace_id)
        || !available.some((item) => item && typeof item === 'object' && 'id' in item && item.id === args.provider)
        || typeof args.title !== 'string' || args.title.length > 256
        || (args.account_id !== undefined && !validId(args.account_id))) throw new Error('Invalid conversation creation')
      const result = await daemon(endpoint, op, { workspace_id: args.workspace_id, provider: args.provider as string,
        title: args.title, ...(args.account_id === undefined ? {} : { account_id: args.account_id }) })
      if (getClientGeneration() !== generation || getSocket() !== endpoint) throw new Error('Profile changed during conversation creation')
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
        scheduleDraft(entry)
      }
      if (op === 'draft.flush') {
        await flushDraft(entry)
        entry.unclearedText = ''
      }
      return { type: 'draft', draft: entry.draft, error: entry.error, sent_text: entry.unclearedText,
        send_pending: pendingSend(entry) }
    }
    if (op === 'conversation.get') return requestDaemon(endpoint, op, { conversation_id: args.conversation_id, limit: 200 })
    if (op === 'agent.cancel' || op === 'agent.resume') {
      const result = await requestDaemon(endpoint, op, { conversation_id: args.conversation_id })
      if (getClientGeneration() !== generation || getSocket() !== endpoint) {
        throw new Error('Profile changed during agent request; inspect the original profile before retrying')
      }
      return result
    }
    if (op === 'agent.send' || op === 'agent.retry_send') {
      try {
      if (args.review_anchor !== undefined && args.review_feedback !== undefined) throw new Error('Choose one review feedback format')
      const reviewWorkspaceId = args.review_feedback === undefined
        ? (args.review_anchor as Record<string, unknown> | null)?.workspace_id
        : (args.review_feedback as Record<string, unknown> | null)?.workspace_id
      const reviewContext = args.review_anchor === undefined && args.review_feedback === undefined
        ? null : activeReviewContext(event.sender.id, reviewWorkspaceId)
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
        if (entry.send.reviewSelection) {
          const selection = selectedWorkspaces.get(event.sender.id)
          if (!selection || selection.workspaceId !== entry.send.reviewSelection.workspaceId ||
            selection.conversationId !== entry.send.reviewSelection.conversationId ||
            selection.generation !== getClientGeneration()) throw new Error('Return to the feedback workspace before retrying')
          entry.send.reviewSelection.epoch = selection.epoch
        } else if (entry.send.reviewAnchor || entry.send.reviewFeedback) {
          const workspaceId = entry.send.reviewAnchor?.workspace_id ?? entry.send.reviewFeedback?.workspace_id as string
          const context = activeReviewContext(event.sender.id, workspaceId)
          assertReviewContext(context, workspaceId, args.conversation_id)
          entry.send.reviewSelection = { senderId: event.sender.id,
            workspaceId,
            conversationId: args.conversation_id, epoch: context.epoch }
        }
        if (entry.send.preparing) return { type: 'send_pending', ...pendingSend(entry) }
        return await dispatchSend(entry, entry.send)
      }
      if (!validId(args.request_id) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 120 * 1024) {
        throw new Error('Invalid prompt')
      }
      if (reviewContext && (entry.draft.text.length || (Array.isArray(entry.draft.attachments) && entry.draft.attachments.length))) {
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
        if (entry.send.preparing) return { type: 'send_pending', ...pendingSend(entry) }
        return await dispatchSend(entry, entry.send)
      }
      if (entry.unclearedText) throw new Error('Finish clearing the previous sent draft before sending again')
      if (reviewContext && entry.draft.revision === 0) {
        entry.draft = { text: '', revision: 1, attachments: [] }
      }
      if (reviewContext) assertReviewContext(reviewContext, reviewWorkspaceId as string, args.conversation_id)
      const intent: SendIntent = { requestId: args.request_id, text, draftText: entry.draft.text,
        revision: entry.draft.revision, attachments: entry.draft.attachments,
        state: 'pending', preparing: true, inFlight: null,
        reviewAnchor: reviewContext ? args.review_anchor as ReviewAnchor : undefined,
        reviewFeedback,
        reviewSelection: reviewContext ? { senderId: event.sender.id,
          workspaceId: reviewWorkspaceId as string,
          conversationId: args.conversation_id, epoch: reviewContext.epoch } : undefined }
      await journal().upsert(journalRecord(entry, intent, false))
      entry.send = intent
      await e2ePauseAfterSendJournal()
      try { await flushDraft(entry) }
      catch {
        try { await journal().remove(journalIdentity(entry, intent)); entry.send = null }
        catch { throw new Error('Draft save and recovery cleanup failed; preserve the pending prompt') }
        throw new Error('Draft could not be saved; prompt was not sent')
      }
      intent.draftText = entry.draft.text
      intent.revision = entry.draft.revision
      intent.attachments = entry.draft.attachments
      intent.preparing = false
      return await dispatchSend(entry, intent)
      } catch (error) {
        if (op !== 'agent.send' || (args.review_anchor === undefined && args.review_feedback === undefined)) throw error
        const entry = drafts.get(draftKey(event.sender.id, endpoint, args.conversation_id))
        if (entry && entry.send?.requestId === args.request_id) {
          return { type: 'send_pending', ...pendingSend(entry) }
        }
        return { type: 'review_rejected', message: String(error) }
      }
    }
    if (!validId(args.request_id) || !['accept', 'decline', 'cancel', 'answer'].includes(String(args.decision))) throw new Error('Invalid answer')
    if (args.decision === 'answer') {
      if (!args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers)
        || Buffer.byteLength(JSON.stringify(args.answers)) > 64 * 1024) throw new Error('Invalid question answers')
    }
    return requestDaemon(endpoint, op, {
      conversation_id: args.conversation_id, request_id: args.request_id,
      decision: args.decision, ...(args.decision === 'answer' ? { answers: args.answers } : {}),
    })
  })
}
