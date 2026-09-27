import type { FeedFrame } from '@ade/client'
import type { TerminalFrame } from '@ade/terminal'

// Messages of the stream bridge (src/stream-bridge): main's control messages, and the per-window
// MessagePort protocol between the preload and the bridge.

/** Main → bridge, over the utility process's parent port. */
export type BridgeControl =
  | { type: 'profile'; socket: string | null }
  | { type: 'window'; windowId: number } // carries the window's MessagePort
  | { type: 'window-closed'; windowId: number }

/** Window (preload) → bridge. */
export type WindowToBridge =
  | { type: 'terminal-attach'; requestId: string; connectionId: string; workspaceId: string; terminalId: string }
  | { type: 'terminal-input'; connectionId: string; data: string }
  | { type: 'terminal-binary'; connectionId: string; bytes: number[] }
  | { type: 'terminal-resize'; connectionId: string; cols: number; rows: number; widthPx: number; heightPx: number }
  | { type: 'terminal-detach'; connectionId: string }

/** Bridge → window (preload). Frames arrive in batches, at most once per animation frame. */
export type BridgeToWindow =
  | { type: 'feed'; frames: FeedFrame[] }
  | { type: 'terminal-frames'; connectionId: string; frames: TerminalFrame[] }
  | { type: 'terminal-close'; connectionId: string; reason: string }
  | { type: 'terminal-attached'; requestId: string; error: string | null }
