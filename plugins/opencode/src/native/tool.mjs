// The provider-neutral tool content shape of ADE's transcript contract
// (`crates/ade-core/src/transcript.rs`). The plugin carries its own copy so the
// packaged artifact depends on nothing outside itself.
export function toolContent(call_id, name, { input = null, output = null, is_error = false } = {}) {
  if (
    typeof call_id !== 'string' ||
    !call_id ||
    Buffer.byteLength(call_id) > 4096 ||
    typeof name !== 'string' ||
    !name ||
    Buffer.byteLength(name) > 256
  )
    throw new Error('Invalid tool identity')
  if (input !== null && Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024)
    throw new Error('Tool input exceeds 1 MiB')
  if (output !== null && (typeof output !== 'string' || Buffer.byteLength(output) > 1024 * 1024))
    throw new Error('Invalid or oversized tool output')
  return { type: 'tool', call_id, name, input, output, is_error }
}
