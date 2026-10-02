// The typed boundary of the JavaScript OpenCode engine. Requests and replies are the
// Rust-generated provider worker contract types.
import type {
  ChildTranscriptPage,
  Connected,
  Event as ProviderEvent,
  ProviderWorkerAck,
  ProviderWorkerAnswerRequest,
  ProviderWorkerCancelRequest,
  ProviderWorkerCancelResult,
  ProviderWorkerChildTranscriptRequest,
  ProviderWorkerFailure,
  ProviderWorkerHistoryPage,
  ProviderWorkerHistoryRequest,
  ProviderWorkerOpenRequest,
  ProviderWorkerSendRequest,
  ProviderWorkerSendResult,
} from '@ade/contracts'

export declare function failure(code: ProviderWorkerFailure['code'], message: string): ProviderWorkerFailure
export declare function asFailure(error: unknown, fallback?: string): ProviderWorkerFailure

export declare class OpenCodeEngine {
  constructor(
    emit: (event: ProviderEvent) => void,
    options?: { cwd?: string; command?: string | null; env?: NodeJS.ProcessEnv; connect?: () => Promise<unknown> },
  )
  readonly version: string | null
  open(params: ProviderWorkerOpenRequest): Promise<Connected>
  send(params: ProviderWorkerSendRequest): Promise<ProviderWorkerSendResult>
  cancel(params: ProviderWorkerCancelRequest): Promise<ProviderWorkerCancelResult>
  answer(params: ProviderWorkerAnswerRequest): Promise<ProviderWorkerAck>
  history(params: ProviderWorkerHistoryRequest, signal?: AbortSignal): Promise<ProviderWorkerHistoryPage>
  childTranscript(params: ProviderWorkerChildTranscriptRequest, signal?: AbortSignal): Promise<ChildTranscriptPage>
  close(): Promise<void>
}
