import type { DaemonRequestError } from '@ade/client'
import { z } from 'zod'

/** Plain data survives both Electron IPC and contextBridge; Error custom properties do not. */
export interface BridgeFailure extends Pick<
  DaemonRequestError,
  'code' | 'message' | 'delivery' | 'replied' | 'recovery' | 'details' | 'operationId'
> {
  name: string
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: BridgeFailure }
export type ResultMethod<F extends (...args: never[]) => Promise<unknown>> = (
  ...args: Parameters<F>
) => Promise<IpcResult<Awaited<ReturnType<F>>>>

const messageSchema = z.object({ message: z.string() })

/** Render both native Error instances and the plain failures copied by contextBridge. */
export function errorMessage(error: unknown): string {
  const result = messageSchema.safeParse(error)
  return result.success ? result.data.message : String(error)
}
