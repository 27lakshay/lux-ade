export function toolContent(call_id, name, { input = null, output = null, is_error = false } = {}) {
  if (typeof call_id !== 'string' || !call_id || Buffer.byteLength(call_id) > 4096 || typeof name !== 'string' || !name || Buffer.byteLength(name) > 256) throw new Error('Invalid tool identity');
  if (input !== null && Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new Error('Tool input exceeds 1 MiB');
  if (output !== null && (typeof output !== 'string' || Buffer.byteLength(output) > 1024 * 1024)) throw new Error('Invalid or oversized tool output');
  return { type: 'tool', call_id, name, input, output, is_error };
}

export function toolOutput(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (!Array.isArray(content)) throw new Error('Invalid tool result content');
  return content.map(block => {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'image' || block.type === 'document') return `[${block.type}]`;
    if (block.type === 'resource_link') return `Resource: ${block.name ?? block.uri ?? 'attachment'}`;
    if (block.type === 'resource') return typeof block.resource?.text === 'string' ? block.resource.text : `Resource: ${block.resource?.uri ?? 'attachment'}`;
    throw new Error(`Unsupported tool result block: ${block.type}`);
  }).join('\n');
}
