import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { DaemonState, DaemonStore } from './daemon-store'

// Read stores through a selector that picks the smallest value the component renders; for a
// conversation, use zustand's useStore(store, selector) with the selectors in conversation-store.ts.
// A selector that builds a new object or array on every call re-renders on every update. Lint
// (ade/require-store-selector) rejects a store read without a selector.

export const DaemonStoreContext = createContext<DaemonStore | null>(null)

export function useDaemon<T>(selector: (state: DaemonState) => T): T {
  const store = useContext(DaemonStoreContext)
  if (!store) throw new Error('useDaemon needs a DaemonStoreContext provider')
  return useStore(store, selector)
}
