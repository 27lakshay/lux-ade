import type { CallRequest, DailyUseOperation, DailyUseResponse } from '@ade/client'

// The daemon operations each bridge forwards. Main accepts exactly these (it checks the op against
// the list at runtime) and the bridge's types come from the same list, so a request and its reply
// are typed by the daemon contract (packages/contracts) from the renderer to the daemon and back.

export const fileOperations = [
  'file.list',
  'file.search',
  'file.preview',
] as const satisfies readonly DailyUseOperation[]

export const reviewOperations = [
  'review.status',
  'review.diff',
  'review.diff_page',
  'review.feedback.search',
  'review.stage',
  'review.unstage',
  'review.commit',
  'review.discard',
  'review.operation',
] as const satisfies readonly DailyUseOperation[]

export const serviceOperations = [
  'service.list',
  'service.inspect',
  'service.configure',
  'service.start',
  'service.stop',
  'service.remove',
  'service.proxy.ensure',
  'service.proxy.inspect',
  'service.proxy.remap',
  'service.proxy.retire',
  'service.proxy.recovery.inspect',
  'service.proxy.recovery.retry',
  'service.proxy.recovery.reset',
  'listener.list',
] as const satisfies readonly DailyUseOperation[]

export const scriptOperations = [
  'script.list',
  'script.runs',
  'script.start',
  'script.inspect',
  'script.stop',
  'script.retire',
] as const satisfies readonly DailyUseOperation[]

const daemonConversationOperations = [
  'provider.list',
  'provider.inspect',
  'provider.readiness',
  'account.list',
  'account.create',
  'account.inspect',
  'account.verify',
  'account.disable',
  'conversation.create',
  'conversation.history',
  'conversation.get',
  'agent.send',
  'agent.answer',
  'agent.cancel',
  'agent.resume',
  'draft.get',
  'draft.save',
  'draft.stash.list',
  'draft.stash.restore',
] as const satisfies readonly DailyUseOperation[]

/**
 * Conversation requests, including two main answers from its own draft and send journal with no
 * daemon operation of the same name: `agent.retry_send` and `draft.flush`.
 */
export const conversationOperations = [...daemonConversationOperations, 'agent.retry_send', 'draft.flush'] as const

export type FileOperation = (typeof fileOperations)[number]
export type ReviewOperation = (typeof reviewOperations)[number]
export type ServiceOperation = (typeof serviceOperations)[number]
export type ScriptOperation = (typeof scriptOperations)[number]
export type ConversationOperation = (typeof conversationOperations)[number]

/** A bridge request method for a set of operations: the contract's request in, its reply out. */
export type ContractRequest<Allowed extends DailyUseOperation> = <O extends Allowed>(
  op: O,
  fields: CallRequest<O>,
) => Promise<DailyUseResponse<O>>

/** Whether `op` is one of `allowed`; main checks every request's op with this. */
export function isAllowedOperation<Allowed extends string>(allowed: readonly Allowed[], op: unknown): op is Allowed {
  return typeof op === 'string' && (allowed as readonly string[]).includes(op)
}
