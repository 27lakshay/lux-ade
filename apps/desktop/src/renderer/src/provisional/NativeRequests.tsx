import { useEffect, useId, useRef, useState } from 'react'
import type { AgentAnswerOutcome, PendingRequest, RequestAnswer } from '@ade/contracts'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import type { ConversationState } from '../state/conversation-store'
import type { DaemonState } from '../state/daemon-store'
import { Body, Text, Title } from '../components/Typography'
import { ScrollArea } from '../components/ui/scroll-area'
import { isRequestScope, PermissionsForm, ChoiceForm } from './NativeRequestChoices'
import { QuestionForm } from './NativeRequestQuestions'

type ProjectionStatus = ConversationState['status']
type LocalAnswerAttempt =
  | { operationId: string; state: 'sending' }
  | { operationId: string; state: 'unknown' }
  | { operationId: string; state: 'outcome'; outcome: AgentAnswerOutcome }
const MAX_TIMER_DELAY_MS = 2_147_483_647

function resolutionLabel(resolution: PendingRequest['resolution']): string {
  switch (resolution) {
    case 'outstanding':
      return 'Outstanding'
    case 'resolved':
      return 'Closed by the native client'
    case 'withdrawn':
      return 'Withdrawn'
    case 'expired':
      return 'Expired'
    case 'unsupported':
      return 'Unsupported'
    case 'invalidated':
      return 'No longer current'
  }
}

function deliveryLabel(
  delivery: PendingRequest['response_delivery'],
  resolution: PendingRequest['resolution'],
  sending: boolean,
): string {
  if (sending) return 'Response is being sent; delivery is not yet known.'
  switch (delivery) {
    case 'not_sent':
      return 'Not sent.'
    case 'admitted':
      return 'Response admitted; awaiting native delivery.'
    case 'dispatched':
    case 'acknowledged':
      return resolution === 'outstanding'
        ? 'Response sent; awaiting native resolution.'
        : 'Response sent; the native request is no longer outstanding.'
    case 'unknown':
      return resolution === 'outstanding'
        ? 'Delivery unknown; awaiting native resolution.'
        : 'Delivery unknown; the native request is no longer outstanding.'
    case 'rejected':
      return resolution === 'outstanding'
        ? 'Response rejected; the request remains outstanding.'
        : 'Response rejected; the native request is no longer outstanding.'
  }
}

function schemaSupport(request: PendingRequest): { supported: boolean; reason: string } {
  if (request.metadata.schema_version !== 1) {
    return { supported: false, reason: `Request schema version ${request.metadata.schema_version} is not supported.` }
  }
  const schema = request.metadata.schema
  switch (schema.kind) {
    case 'choices':
      return schema.choices.length > 0
        ? { supported: true, reason: '' }
        : { supported: false, reason: 'This request has no response choices.' }
    case 'questions': {
      const ids = new Set<string>()
      for (const question of schema.questions) {
        const options = question.options ?? []
        if (!question.id || ids.has(question.id) || (!options.length && !question.allow_other)) {
          return { supported: false, reason: 'This request has a question this version cannot answer safely.' }
        }
        ids.add(question.id)
      }
      return schema.questions.length > 0
        ? { supported: true, reason: '' }
        : { supported: false, reason: 'This request has no questions to answer.' }
    }
    case 'permissions':
      return schema.requested !== null &&
        schema.requested !== undefined &&
        schema.scopes.length > 0 &&
        schema.scopes.every(isRequestScope)
        ? { supported: true, reason: '' }
        : { supported: false, reason: 'This permission request has no usable response scope or payload.' }
    case 'unsupported':
      return { supported: false, reason: schema.reason || 'This request schema is not supported.' }
    default:
      return { supported: false, reason: 'This request schema is not supported.' }
  }
}

export function NativeRequests({
  conversationId,
  requests,
  projectionStatus,
  connectionStatus,
  conversations,
  profileIdentity,
  accountIdentity,
  isContextCurrent,
}: {
  conversationId: string
  requests: PendingRequest[]
  projectionStatus: ProjectionStatus
  connectionStatus: DaemonState['status']
  conversations: ConversationsBridge
  profileIdentity: string
  accountIdentity: string
  isContextCurrent: (profileIdentity: string, accountIdentity: string) => boolean
}) {
  if (!requests.length) return null
  return (
    <ScrollArea className="mb-3 h-[min(38vh,22rem)] min-h-0 shrink-0">
      <section aria-label="Agent requests" className="space-y-2 bg-card p-3">
        <Title as="h2">Agent requests</Title>
        {requests.map((request) => (
          <RequestCard
            key={request.id + ':' + request.source_attempt_id + ':' + request.revision}
            conversationId={conversationId}
            request={request}
            projectionStatus={projectionStatus}
            connectionStatus={connectionStatus}
            conversations={conversations}
            profileIdentity={profileIdentity}
            accountIdentity={accountIdentity}
            isContextCurrent={isContextCurrent}
          />
        ))}
      </section>
    </ScrollArea>
  )
}

function RequestCard({
  conversationId,
  request,
  projectionStatus,
  connectionStatus,
  conversations,
  profileIdentity,
  accountIdentity,
  isContextCurrent,
}: {
  conversationId: string
  request: PendingRequest
  projectionStatus: ProjectionStatus
  connectionStatus: DaemonState['status']
  conversations: ConversationsBridge
  profileIdentity: string
  accountIdentity: string
  isContextCurrent: (profileIdentity: string, accountIdentity: string) => boolean
}) {
  const headingId = useId()
  const [attempt, setAttempt] = useState<LocalAnswerAttempt | null>(null)
  const attemptRef = useRef<LocalAnswerAttempt | null>(null)
  const activeRef = useRef(true)
  const expiresAt = request.metadata.expires_at_ms
  const [elapsedDeadline, setElapsedDeadline] = useState<number | null>(null)
  const [checkedDeadline, setCheckedDeadline] = useState<{ expiresAt: number; checkedAt: number } | null>(() =>
    expiresAt === null || expiresAt === undefined ? null : { expiresAt, checkedAt: Date.now() },
  )
  useEffect(() => {
    if (expiresAt === null || expiresAt === undefined) return
    let timer: number | undefined
    const checkDeadline = (): void => {
      const checkedAt = Date.now()
      setCheckedDeadline({ expiresAt, checkedAt })
      const remaining = expiresAt - checkedAt
      if (remaining <= 0) {
        setElapsedDeadline(expiresAt)
        return
      }
      timer = window.setTimeout(checkDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS))
    }
    timer = window.setTimeout(checkDeadline, Math.min(Math.max(0, expiresAt - Date.now()), MAX_TIMER_DELAY_MS))
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [expiresAt])
  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])
  const matchingDeadline = checkedDeadline?.expiresAt === expiresAt ? checkedDeadline : null
  const expired =
    expiresAt !== null &&
    expiresAt !== undefined &&
    (matchingDeadline === null || expiresAt <= matchingDeadline.checkedAt || elapsedDeadline === expiresAt)
  const support = schemaSupport(request)
  const contextCurrent = isContextCurrent(profileIdentity, accountIdentity)
  const readOnlyReason =
    projectionStatus !== 'current'
      ? `conversation state is ${projectionStatus}`
      : connectionStatus !== 'connected'
        ? `the daemon is ${connectionStatus}`
        : null
  const remoteOperationId = request.response_operation_id
  const matchingRemote = attempt !== null && remoteOperationId === attempt.operationId
  const remoteDeliveryExists = request.response_delivery !== 'not_sent'
  const localOutcome = attempt?.state === 'outcome' && !matchingRemote ? attempt.outcome : null
  const delivery =
    matchingRemote || remoteDeliveryExists
      ? request.response_delivery
      : (localOutcome?.response_delivery ?? (attempt?.state === 'unknown' ? 'unknown' : request.response_delivery))
  const resolution =
    request.resolution !== 'outstanding' ? request.resolution : (localOutcome?.resolution ?? request.resolution)
  const sending = attempt?.state === 'sending' && !matchingRemote
  const hasRemoteResponse = (remoteOperationId !== null && remoteOperationId !== undefined) || remoteDeliveryExists
  const formVisible = request.resolution === 'outstanding' && support.supported && !expired && !hasRemoteResponse
  const disabled =
    readOnlyReason !== null ||
    !contextCurrent ||
    request.resolution !== 'outstanding' ||
    expired ||
    !support.supported ||
    hasRemoteResponse ||
    attempt !== null

  const sendAnswer = async (answer: RequestAnswer): Promise<void> => {
    if (disabled || attemptRef.current) return
    const operationId = globalThis.crypto.randomUUID()
    const sendingAttempt: LocalAnswerAttempt = { operationId, state: 'sending' }
    attemptRef.current = sendingAttempt
    setAttempt(sendingAttempt)
    try {
      const outcome = await conversations.request('agent.answer', {
        operation_id: operationId,
        conversation_id: conversationId,
        request_id: request.id,
        source_attempt_id: request.source_attempt_id,
        request_revision: request.revision,
        answer,
      })
      const settled: LocalAnswerAttempt = { operationId, state: 'outcome', outcome }
      attemptRef.current = settled
      if (activeRef.current) setAttempt(settled)
    } catch {
      const uncertain: LocalAnswerAttempt = { operationId, state: 'unknown' }
      attemptRef.current = uncertain
      if (activeRef.current) setAttempt(uncertain)
    }
  }

  const schema = request.metadata.schema
  const summary = request.metadata.summary.trim() || 'Native request from the agent'
  const answerError = localOutcome?.error
    ? 'The native client returned an error. Refresh the conversation before answering again.'
    : ''
  return (
    <article aria-labelledby={headingId} className="rounded-lg bg-card p-3 text-card-foreground">
      <Title as="h3" id={headingId}>
        {summary}
      </Title>
      <dl className="mt-2 grid gap-1 sm:grid-cols-2">
        <div>
          <dt>
            <Text tone="muted">Request status</Text>
          </dt>
          <dd>
            <Text>{resolutionLabel(resolution)}</Text>
          </dd>
        </div>
        <div>
          <dt>
            <Text tone="muted">Response delivery</Text>
          </dt>
          <dd role="status" aria-live="polite">
            <Text>{deliveryLabel(delivery, resolution, sending)}</Text>
          </dd>
        </div>
      </dl>
      {request.resolution === 'resolved' && (
        <Body className="mt-2" tone="muted" role="status">
          Closing the request does not confirm whether the requested effect took place.
        </Body>
      )}
      {readOnlyReason !== null && request.resolution === 'outstanding' && (
        <Body className="mt-2" tone="muted" role="status">
          Request controls are read-only while {readOnlyReason}.
        </Body>
      )}
      {!contextCurrent && request.resolution === 'outstanding' && (
        <Body className="mt-2" tone="muted" role="status">
          The selected profile changed. Refresh the conversation before answering this request.
        </Body>
      )}
      {expired && request.resolution === 'outstanding' && (
        <Body className="mt-2" tone="muted" role="status">
          The response deadline has passed; waiting for the native request status.
        </Body>
      )}
      {!support.supported && (
        <Body className="mt-2" tone="muted" role="status">
          {support.reason}
        </Body>
      )}
      {answerError && (
        <Body className="mt-2 text-destructive" role="alert">
          {answerError}
        </Body>
      )}
      {attempt?.state === 'unknown' && (
        <Body className="mt-2" tone="muted" role="status">
          ADE could not confirm whether the response was sent. This view will not send it again automatically.
        </Body>
      )}
      {delivery === 'rejected' && (
        <Body className="mt-2" tone="muted" role="alert">
          The response was rejected. Refresh the conversation before answering again.
        </Body>
      )}
      {formVisible && (
        <div className="mt-3">
          {schema.kind === 'choices' && (
            <ChoiceForm choices={schema.choices} disabled={disabled} onAnswer={sendAnswer} />
          )}
          {schema.kind === 'questions' && (
            <QuestionForm
              questions={schema.questions}
              decline={schema.decline}
              disabled={disabled}
              onAnswer={sendAnswer}
            />
          )}
          {schema.kind === 'permissions' && (
            <PermissionsForm schema={schema} disabled={disabled} onAnswer={sendAnswer} />
          )}
        </div>
      )}
    </article>
  )
}
