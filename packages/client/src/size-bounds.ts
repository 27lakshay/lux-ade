const MAX_DECODED_NODES = 100_000
const MAX_DECODED_DEPTH = 64
const NODE_OVERHEAD_BYTES = 32
const KEY_OVERHEAD_BYTES = 16

/** O(1) UTF-16 storage estimate for a string; this is a budget, not a heap measurement. */
function utf16SizeWithin(value: string, limit: number): number | null {
  const bytes = value.length * 2
  return bytes <= limit ? bytes : null
}

/** Includes bounded node and property overhead for JSON-like native data. */
export function decodedSizeWithin(values: readonly unknown[], limit: number): number | null {
  let bytes = 0
  let nodes = 0
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > MAX_DECODED_NODES || depth > MAX_DECODED_DEPTH) return false
    bytes += NODE_OVERHEAD_BYTES
    if (bytes > limit) return false
    if (typeof value === 'string') {
      const size = utf16SizeWithin(value, limit - bytes)
      if (size === null) return false
      bytes += size
    } else if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        if (value.length > MAX_DECODED_NODES - nodes) return false
        for (let index = 0; index < value.length; index++) {
          if (!visit(value[index], depth + 1)) return false
        }
      } else {
        for (const key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            if (bytes > limit - KEY_OVERHEAD_BYTES) return false
            const keySize = utf16SizeWithin(key, limit - bytes - KEY_OVERHEAD_BYTES)
            if (keySize === null) return false
            bytes += keySize + KEY_OVERHEAD_BYTES
            if (!visit((value as Record<string, unknown>)[key], depth + 1)) return false
          }
        }
      }
    }
    return bytes <= limit
  }
  try {
    for (const value of values) if (!visit(value, 0)) return null
    return bytes
  } catch {
    return null
  }
}
