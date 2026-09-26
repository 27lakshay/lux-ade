// Generated from protocol/daily-use.json by scripts/generate-client-contract.mjs. Do not edit.

export type WireAttachment = {
  "id": string;
  "name": string;
  "media_type": string;
  "size": number;
  [key: string]: unknown;
}

export type WireWorkspace = {
  "id": string;
  "repository_id": string | null;
  "root": string;
  "name": string;
  "terminal_id": string;
  "extra_terminals": Array<string>;
  "needs_rebind": boolean;
  "worktree_lifecycle_needs_rebind": boolean;
  [key: string]: unknown;
}

export type WireConversation = {
  "id": string;
  "workspace_id": string;
  "title": string;
  "provider": string;
  "account_id": string | null;
  "account_context": string;
  "provider_config": unknown;
  "provider_thread_id": string | null;
  "status": string;
  "active_turn_id": string | null;
  "error": string | null;
  "updated_at": number;
  "view_terminal": unknown | null;
  "terminal_owner": unknown | null;
  "queue_paused": boolean;
  "runtime_run": string | null;
  "runtime_cursor": number;
  "runtime_submission": string | null;
  [key: string]: unknown;
}

export type WireMessage = {
  "id": string;
  "conversation_id": string;
  "role": string;
  "kind": string;
  "text": string;
  "status": string;
  "turn_id": string | null;
  "provider_item_id": string | null;
  "sequence": number;
  "attachments"?: Array<WireAttachment>;
  "content"?: unknown;
  "review_feedback"?: unknown;
  [key: string]: unknown;
}

export type WirePendingRequest = {
  "id": string;
  "conversation_id": string;
  "run_id": string;
  "rpc_id": unknown;
  "method": string;
  "params": unknown;
  "status": string;
  "answer_fingerprint"?: string;
  "answer_dispatched": boolean;
  "answer_attempt": number;
  [key: string]: unknown;
}

export type WireQueuedPrompt = {
  "id": string;
  "conversation_id": string;
  "text": string;
  "status": string;
  "attachments"?: Array<WireAttachment>;
  [key: string]: unknown;
}

export type WireProviderDescriptor = {
  "id": string;
  "name": string;
  "capabilities": Array<string>;
  "permission_modes": Array<string>;
  "setting_sources": Array<string>;
  [key: string]: unknown;
}

export type WireCatalog = {
  "workspaces": Array<WireWorkspace>;
  "conversations": Array<WireConversation>;
  "windows": Array<unknown>;
  [key: string]: unknown;
}

export type CatalogGetRequest = {
  "op": "catalog.get";
}

export type CatalogGetResponse = {
  "type": "catalog";
  "catalog": WireCatalog;
  "providers": Array<WireProviderDescriptor>;
  "boot_id": string;
  "revision": number;
  [key: string]: unknown;
}

export type ConversationGetRequest = {
  "op": "conversation.get";
  "conversation_id": string;
  "before"?: number;
  "limit"?: number;
}

export type ConversationGetResponse = {
  "type": "conversation_snapshot";
  "conversation": WireConversation;
  "messages": Array<WireMessage>;
  "requests": Array<WirePendingRequest>;
  "queued": Array<WireQueuedPrompt>;
  "boot_id": string;
  "revision": number;
  [key: string]: unknown;
}

export type AgentSendRequest = {
  "op": "agent.send";
  "conversation_id": string;
  "request_id": string;
  "text": string;
  "attachments"?: Array<WireAttachment>;
}

export type AgentSendResponse = {
  "type": "ack";
  [key: string]: unknown;
}

export type AgentAnswerRequest = {
  "op": "agent.answer";
  "conversation_id": string;
  "request_id": string;
  "decision": string;
  "answers"?: unknown;
}

export type AgentAnswerResponse = {
  "type": "ack";
  [key: string]: unknown;
}

export type CatalogFeedFrame = {
  "type": "catalog";
  "catalog": WireCatalog;
  "providers": Array<WireProviderDescriptor>;
  "boot_id": string;
  "revision": number;
  [key: string]: unknown;
}

export type ConversationChangedFeedFrame = {
  "type": "conversation_changed";
  "conversation": WireConversation;
  "messages": Array<WireMessage>;
  "requests": Array<WirePendingRequest>;
  "queued": Array<WireQueuedPrompt>;
  "boot_id": string;
  "revision": number;
  [key: string]: unknown;
}

export type DailyUseOperation = "catalog.get" | "conversation.get" | "agent.send" | "agent.answer"

export interface DailyUseRequestByOperation {
  "catalog.get": CatalogGetRequest;
  "conversation.get": ConversationGetRequest;
  "agent.send": AgentSendRequest;
  "agent.answer": AgentAnswerRequest;
}

export interface DailyUseResponseByOperation {
  "catalog.get": CatalogGetResponse;
  "conversation.get": ConversationGetResponse;
  "agent.send": AgentSendResponse;
  "agent.answer": AgentAnswerResponse;
}

export type DailyUseRequest<O extends DailyUseOperation = DailyUseOperation> = DailyUseRequestByOperation[O]
export type DailyUseResponse<O extends DailyUseOperation = DailyUseOperation> = DailyUseResponseByOperation[O]
export type DailyUseFeedFrame = CatalogFeedFrame | ConversationChangedFeedFrame

type Spec = string | { ref: string } | { literal: unknown } | { array: Spec } | { nullable: Spec } | { optional: Spec } | { fields: Record<string, Spec>; additional?: boolean }

const contract: { version: number; definitions: Record<string, Spec>; operations: Record<string, { request: Spec; response: Spec }>; feed: Record<string, Spec> } = {"version":1,"definitions":{"Attachment":{"fields":{"id":"string","name":"string","media_type":"string","size":"integer"},"additional":true},"Workspace":{"fields":{"id":"string","repository_id":{"nullable":"string"},"root":"string","name":"string","terminal_id":"string","extra_terminals":{"array":"string"},"needs_rebind":"boolean","worktree_lifecycle_needs_rebind":"boolean"},"additional":true},"Conversation":{"fields":{"id":"string","workspace_id":"string","title":"string","provider":"string","account_id":{"nullable":"string"},"account_context":"string","provider_config":"unknown","provider_thread_id":{"nullable":"string"},"status":"string","active_turn_id":{"nullable":"string"},"error":{"nullable":"string"},"updated_at":"integer","view_terminal":{"nullable":"unknown"},"terminal_owner":{"nullable":"unknown"},"queue_paused":"boolean","runtime_run":{"nullable":"string"},"runtime_cursor":"integer","runtime_submission":{"nullable":"string"}},"additional":true},"Message":{"fields":{"id":"string","conversation_id":"string","role":"string","kind":"string","text":"string","status":"string","turn_id":{"nullable":"string"},"provider_item_id":{"nullable":"string"},"sequence":"integer","attachments":{"optional":{"array":{"ref":"Attachment"}}},"content":{"optional":"unknown"},"review_feedback":{"optional":"unknown"}},"additional":true},"PendingRequest":{"fields":{"id":"string","conversation_id":"string","run_id":"string","rpc_id":"unknown","method":"string","params":"unknown","status":"string","answer_fingerprint":{"optional":"string"},"answer_dispatched":"boolean","answer_attempt":"integer"},"additional":true},"QueuedPrompt":{"fields":{"id":"string","conversation_id":"string","text":"string","status":"string","attachments":{"optional":{"array":{"ref":"Attachment"}}}},"additional":true},"ProviderDescriptor":{"fields":{"id":"string","name":"string","capabilities":{"array":"string"},"permission_modes":{"array":"string"},"setting_sources":{"array":"string"}},"additional":true},"Catalog":{"fields":{"workspaces":{"array":{"ref":"Workspace"}},"conversations":{"array":{"ref":"Conversation"}},"windows":{"array":"unknown"}},"additional":true}},"operations":{"catalog.get":{"request":{"fields":{"op":{"literal":"catalog.get"}}},"response":{"fields":{"type":{"literal":"catalog"},"catalog":{"ref":"Catalog"},"providers":{"array":{"ref":"ProviderDescriptor"}},"boot_id":"string","revision":"integer"},"additional":true}},"conversation.get":{"request":{"fields":{"op":{"literal":"conversation.get"},"conversation_id":"string","before":{"optional":"integer"},"limit":{"optional":"integer"}}},"response":{"fields":{"type":{"literal":"conversation_snapshot"},"conversation":{"ref":"Conversation"},"messages":{"array":{"ref":"Message"}},"requests":{"array":{"ref":"PendingRequest"}},"queued":{"array":{"ref":"QueuedPrompt"}},"boot_id":"string","revision":"integer"},"additional":true}},"agent.send":{"request":{"fields":{"op":{"literal":"agent.send"},"conversation_id":"string","request_id":"string","text":"string","attachments":{"optional":{"array":{"ref":"Attachment"}}}}},"response":{"fields":{"type":{"literal":"ack"}},"additional":true}},"agent.answer":{"request":{"fields":{"op":{"literal":"agent.answer"},"conversation_id":"string","request_id":"string","decision":"string","answers":{"optional":"unknown"}}},"response":{"fields":{"type":{"literal":"ack"}},"additional":true}}},"feed":{"catalog":{"fields":{"type":{"literal":"catalog"},"catalog":{"ref":"Catalog"},"providers":{"array":{"ref":"ProviderDescriptor"}},"boot_id":"string","revision":"integer"},"additional":true},"conversation_changed":{"fields":{"type":{"literal":"conversation_changed"},"conversation":{"ref":"Conversation"},"messages":{"array":{"ref":"Message"}},"requests":{"array":{"ref":"PendingRequest"}},"queued":{"array":{"ref":"QueuedPrompt"}},"boot_id":"string","revision":"integer"},"additional":true}}}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validate(spec: Spec, value: unknown, at: string): void {
  if (typeof spec === 'string') {
    const valid = spec === 'unknown' || (spec === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : typeof value === spec)
    if (!valid) throw new TypeError(`Invalid daily-use frame at ${at}: expected ${spec}`)
    return
  }
  if ('ref' in spec) return validate(contract.definitions[spec.ref], value, at)
  if ('literal' in spec) {
    if (value !== spec.literal) throw new TypeError(`Invalid daily-use frame at ${at}: expected ${JSON.stringify(spec.literal)}`)
    return
  }
  if ('array' in spec) {
    if (!Array.isArray(value)) throw new TypeError(`Invalid daily-use frame at ${at}: expected array`)
    value.forEach((item, index) => validate(spec.array, item, `${at}[${index}]`))
    return
  }
  if ('nullable' in spec) {
    if (value !== null) validate(spec.nullable, value, at)
    return
  }
  if ('optional' in spec) {
    if (value !== undefined) validate(spec.optional, value, at)
    return
  }
  if (!record(value)) throw new TypeError(`Invalid daily-use frame at ${at}: expected object`)
  for (const [key, field] of Object.entries(spec.fields)) {
    if (!(key in value) && !(typeof field === 'object' && 'optional' in field)) {
      throw new TypeError(`Invalid daily-use frame at ${at}.${key}: missing field`)
    }
    validate(field, value[key], `${at}.${key}`)
  }
  if (!spec.additional) {
    for (const key of Object.keys(value)) {
      if (!(key in spec.fields)) throw new TypeError(`Invalid daily-use frame at ${at}.${key}: unexpected field`)
    }
  }
}

export function decodeDailyUseRequest(value: unknown): DailyUseRequest {
  if (!record(value) || typeof value.op !== 'string' || !Object.hasOwn(contract.operations, value.op)) {
    throw new TypeError('Invalid daily-use request operation')
  }
  validate(contract.operations[value.op].request, value, 'request')
  return value as DailyUseRequest
}

export function decodeDailyUseResponse<O extends DailyUseOperation>(op: O, value: unknown): DailyUseResponse<O> {
  validate(contract.operations[op].response, value, 'response')
  return value as DailyUseResponse<O>
}

export function decodeDailyUseFeedFrame(value: unknown): DailyUseFeedFrame {
  if (!record(value) || typeof value.type !== 'string' || !Object.hasOwn(contract.feed, value.type)) {
    throw new TypeError('Invalid daily-use feed frame type')
  }
  validate(contract.feed[value.type], value, 'feed')
  return value as DailyUseFeedFrame
}
