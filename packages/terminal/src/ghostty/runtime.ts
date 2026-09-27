// Portions adapted from t3code apps/web/src/terminal/ghostty/runtime.ts (MIT).
//
// The libghostty-vt WebAssembly instance, shared by every terminal in the window. It is built from
// the same pinned Ghostty source as the daemon (scripts/build-ghostty-wasm.mjs), so the window can
// decode the daemon's Ghostty snapshots. Struct layouts are read from the module itself
// (`ghostty_type_json`), not hardcoded.
//
// Unlike t3code, the window's terminal never writes replies back to the program: the daemon's
// Ghostty already answered every query, and a second answer would reach the program twice
// (decision D06). So there is no write-PTY trampoline.

type WasmFunction = (...args: Array<number | bigint>) => number

interface TypeField {
  readonly offset: number
  readonly size: number
  readonly type: string
}

interface TypeLayout {
  readonly size: number
  readonly align: number
  readonly fields: Readonly<Record<string, TypeField>>
}

type TypeLayouts = Readonly<Record<string, TypeLayout>>

const textDecoder = new TextDecoder()

export class GhosttyRuntime {
  readonly memory: WebAssembly.Memory
  readonly layouts: TypeLayouts
  private readonly exports: WebAssembly.Exports
  private memoryView: DataView

  private constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports
    const memory = instance.exports.memory
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error('libghostty-vt did not export WebAssembly memory')
    }
    this.memory = memory
    this.memoryView = new DataView(memory.buffer)
    const jsonPointer = this.call('ghostty_type_json')
    const bytes = new Uint8Array(memory.buffer)
    let end = jsonPointer
    while (end < bytes.length && bytes[end] !== 0) end += 1
    // Newer libghostty-vt wraps the layouts in `types`, next to ABI and version metadata.
    const parsed = JSON.parse(textDecoder.decode(bytes.subarray(jsonPointer, end))) as {
      types?: TypeLayouts
    } & TypeLayouts
    this.layouts = parsed.types ?? parsed
  }

  /** Instantiates the module from its bytes. */
  static async fromBytes(bytes: BufferSource): Promise<GhosttyRuntime> {
    const { instance } = await WebAssembly.instantiate(bytes, {})
    return new GhosttyRuntime(instance)
  }

  call(name: string, ...args: Array<number | bigint>): number {
    const fn = this.exports[name]
    if (typeof fn !== 'function') {
      throw new Error(`libghostty-vt export is unavailable: ${name}`)
    }
    return (fn as WasmFunction)(...args)
  }

  layout(name: string): TypeLayout {
    const layout = this.layouts[name]
    if (!layout) throw new Error(`libghostty-vt type layout is unavailable: ${name}`)
    return layout
  }

  alloc(size: number): number {
    const pointer = this.call('ghostty_wasm_alloc', size)
    if (pointer === 0) throw new Error(`libghostty-vt failed to allocate ${size} bytes`)
    new Uint8Array(this.memory.buffer, pointer, size).fill(0)
    return pointer
  }

  free(pointer: number, size: number): void {
    if (pointer !== 0) this.call('ghostty_wasm_free', pointer, size)
  }

  allocOpaque(): number {
    const pointer = this.call('ghostty_wasm_alloc_opaque')
    if (pointer === 0) throw new Error('libghostty-vt failed to allocate an opaque pointer')
    // The slot is uninitialized until a *_new call writes it; zero it so dispose
    // paths that run after a partial initialization never free a garbage pointer.
    new DataView(this.memory.buffer).setUint32(pointer, 0, true)
    return pointer
  }

  freeOpaque(pointer: number): void {
    if (pointer !== 0) this.call('ghostty_wasm_free_opaque', pointer)
  }

  readPointer(slot: number): number {
    return this.currentMemoryView().getUint32(slot, true)
  }

  view(pointer: number, size?: number): DataView {
    return new DataView(this.memory.buffer, pointer, size)
  }

  bytes(pointer: number, size: number): Uint8Array {
    return new Uint8Array(this.memory.buffer, pointer, size)
  }

  /** Reuse scalar reads across cells, refreshing after any terminal grows shared WASM memory. */
  private currentMemoryView(): DataView {
    if (this.memoryView.buffer !== this.memory.buffer) {
      this.memoryView = new DataView(this.memory.buffer)
    }
    return this.memoryView
  }

  /**
   * A field's scalar kind. Named integer types (a typedef such as GhosttyMode) are read by their
   * byte size as unsigned integers.
   */
  private scalarType(field: TypeField): string {
    if (['bool', 'u8', 'u16', 'i32', 'u32', 'enum', 'u64'].includes(field.type)) return field.type
    const bySize: Record<number, string> = { 1: 'u8', 2: 'u16', 4: 'u32', 8: 'u64' }
    return bySize[field.size] ?? field.type
  }

  setField(pointer: number, structName: string, fieldName: string, value: number): void {
    const field = this.layout(structName).fields[fieldName]
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`)
    const view = this.currentMemoryView()
    const offset = pointer + field.offset
    switch (this.scalarType(field)) {
      case 'bool':
      case 'u8':
        view.setUint8(offset, value)
        return
      case 'u16':
        view.setUint16(offset, value, true)
        return
      case 'i32':
        view.setInt32(offset, value, true)
        return
      case 'u32':
      case 'enum':
        view.setUint32(offset, value, true)
        return
      case 'u64':
        view.setBigUint64(offset, BigInt(value), true)
        return
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`)
    }
  }

  readField(pointer: number, structName: string, fieldName: string): number {
    const field = this.layout(structName).fields[fieldName]
    if (!field) throw new Error(`libghostty-vt field is unavailable: ${structName}.${fieldName}`)
    const view = this.currentMemoryView()
    const offset = pointer + field.offset
    switch (this.scalarType(field)) {
      case 'bool':
      case 'u8':
        return view.getUint8(offset)
      case 'u16':
        return view.getUint16(offset, true)
      case 'i32':
        return view.getInt32(offset, true)
      case 'u32':
      case 'enum':
        return view.getUint32(offset, true)
      case 'u64':
        return Number(view.getBigUint64(offset, true))
      default:
        throw new Error(`Unsupported libghostty-vt field type: ${field.type}`)
    }
  }
}

let runtimePromise: Promise<GhosttyRuntime> | null = null
let loadBytes: () => Promise<BufferSource> = async () => {
  const { default: url } = await import('./vendor/ghostty-vt.wasm?url')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Unable to load libghostty-vt (${response.status})`)
  return response.arrayBuffer()
}

/**
 * Replaces how the module's bytes are read. The app fetches the bundled asset; tests and Node
 * (the protocol E2E) read the file instead. Call before the first terminal is created.
 */
export function setGhosttyWasmSource(source: () => Promise<BufferSource>): void {
  loadBytes = source
  runtimePromise = null
}

export function loadGhosttyRuntime(): Promise<GhosttyRuntime> {
  runtimePromise ??= loadBytes()
    .then((bytes) => GhosttyRuntime.fromBytes(bytes))
    .catch((error: unknown) => {
      runtimePromise = null
      throw error
    })
  return runtimePromise
}
