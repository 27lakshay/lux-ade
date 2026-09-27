// Orchestration steps over the SDK for this area's specs. Every wait repeats
// a non-blocking daemon query; none sleeps for a fixed time.
import { expect, prompts, type ScratchProfile } from '../fixtures'

/** An `orchestration.child.wait` reply, with its flattened state fields. */
export type Wait = {
  type: string
  child_conversation_id: string
  message_id: string
  state: string
  done: boolean
  deadline_ms: number
  outcome?: string
  error?: string | null
  phase?: string
  request_ids?: string[]
  reason?: string
}

let operationNumber = 0
/** A fresh caller-owned operation ID. */
export function opId(label: string): string {
  return `e2e2-${label}-${process.pid}-${++operationNumber}`
}

/** One `orchestration.child.wait` observation. */
export async function waitOnce(
  profile: ScratchProfile,
  child: string,
  options: { messageId?: string; timeoutMs?: number; deadlineMs?: number } = {},
): Promise<Wait> {
  return await profile.call('orchestration.child.wait', {
    child_conversation_id: child,
    ...(options.messageId ? { message_id: options.messageId } : {}),
    ...(options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
    ...(options.deadlineMs !== undefined ? { deadline_ms: options.deadlineMs } : {}),
  })
}

/** Repeat the wait until it reports `state` (and `outcome`, when given), and return that reply. */
export async function waitForChild(
  profile: ScratchProfile,
  child: string,
  state: string,
  options: { messageId?: string; outcome?: string; timeout?: number } = {},
): Promise<Wait> {
  let last: Wait | undefined
  await expect
    .poll(
      async () => {
        last = await waitOnce(profile, child, { messageId: options.messageId, timeoutMs: 0 })
        return options.outcome ? `${last.state}:${last.outcome}` : last.state
      },
      { timeout: options.timeout ?? 20_000 },
    )
    .toBe(options.outcome ? `${state}:${options.outcome}` : state)
  return last as Wait
}

/** Open a workspace at `path` and create a parent Conversation on `provider` in it. */
export async function parentIn(profile: ScratchProfile, path: string, provider: 'codex' | 'claude' = 'codex') {
  const { workspace } = await profile.call('workspace.open', { path })
  const { conversation } = await profile.call('conversation.create', { workspace_id: workspace.id, provider })
  return { workspace, parent: conversation.id }
}

/** Delegate `task` from `parent` to a Codex child in the parent's workspace, as the user. */
export async function delegate(
  profile: ScratchProfile,
  parent: string,
  task: string = prompts.turn,
  extra: { provider?: string; account?: 'inherit' | 'ambient' } = {},
) {
  const { child } = await profile.call('orchestration.delegate', {
    operation_id: opId('delegate'),
    parent_conversation_id: parent,
    caller: { kind: 'user' },
    provider: extra.provider ?? 'codex',
    account: { mode: extra.account ?? 'inherit' },
    workspace: { mode: 'same' },
    task,
  })
  return child
}

/** The parent's view of one child: its record in `orchestration.children`. */
export async function childView(profile: ScratchProfile, parent: string, child: string) {
  const { children } = await profile.call('orchestration.children', { parent_conversation_id: parent })
  const record = children.find((item) => item.child_conversation_id === child)
  if (!record) throw new Error(`Child ${child} is missing from the parent's view`)
  return record
}

/** Wait until the Conversation's status matches `status`. */
export async function waitForStatus(
  profile: ScratchProfile,
  conversation: string,
  status: RegExp | string,
  timeout = 20_000,
): Promise<void> {
  const read = async () =>
    (await profile.call('conversation.get', { conversation_id: conversation })).conversation.status
  if (typeof status === 'string') await expect.poll(read, { timeout }).toBe(status)
  else await expect.poll(read, { timeout }).toMatch(status)
}
