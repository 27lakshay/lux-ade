import { MAX_RPC_FRAME_BYTES } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame'

export function promptPayload({ text, attachments = [] }) {
  if (typeof text !== 'string') throw new Error('Oh My Pi prompt text must be a string')
  const parts = [text],
    images = []
  for (const { attachment, data } of attachments) {
    if (attachment.media_type.startsWith('image/'))
      images.push({ type: 'image', mimeType: attachment.media_type, data })
    else
      parts.push(
        `Attached file ${attachment.name}:\n${new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(data, 'base64'))}`,
      )
  }
  return { message: parts.join('\n\n'), ...(images.length ? { images } : {}) }
}

// This is the only path that may dispatch a new RPC prompt. Receipt insertion
// commits first. Neither an ack nor a failed connection proves durable execution.
export async function admit({ transport, history, ledger, session, submission, turn, prompt, onDispatch = () => {} }) {
  const payload = promptPayload(prompt)
  const request = { ...payload, type: 'prompt', id: turn }
  if (Buffer.byteLength(JSON.stringify(request) + '\n') > MAX_RPC_FRAME_BYTES)
    throw new Error('Oh My Pi prompt and attachments exceed its 1 MiB RPC input limit')
  const existing = ledger.get(session, submission)
  if (existing) {
    // begin validates the fingerprint even on a retry; it never dispatches one.
    return ledger.begin({ session, submission, turn, payload })
  }
  const state = await transport.request('get_state')
  if (state.sessionId !== session) throw new Error('Oh My Pi session identity changed')
  if (state.isStreaming || state.isCompacting || state.queuedMessageCount)
    throw new Error('Oh My Pi has active work; wait for it to settle')
  const snapshot = await history.refresh()
  const admission = ledger.begin({ session, submission, turn, payload, baseline: snapshot.entries.at(-1)?.id ?? null })
  if (!admission.fresh) return admission
  onDispatch(admission.receipt)
  const acknowledgement = await transport.request('prompt', payload, { id: turn })
  return { ...admission, acknowledgement }
}
