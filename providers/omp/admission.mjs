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
