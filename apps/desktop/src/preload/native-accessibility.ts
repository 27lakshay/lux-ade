import { invoke, subscribe } from './ipc'
import type { NativeAccessibilityBridge } from '../shared/bridge/native-accessibility'

export const nativeAccessibility: NativeAccessibilityBridge = {
  getSnapshot: () => invoke('ade:native-accessibility-snapshot'),
  onUpdate: (listener) => subscribe('ade:native-accessibility-updated', listener),
}
