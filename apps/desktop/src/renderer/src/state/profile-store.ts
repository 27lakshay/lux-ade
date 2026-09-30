import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ProfilesBridge } from '../../../shared/bridge/profiles'
export type ProfileStore = StoreApi<{ error: string }>

/** Projects main's profile state, including launcher failures before a daemon connects. */
export function createProfileStore(host: Pick<ProfilesBridge, 'getState' | 'onState'>): {
  store: ProfileStore
  stop: () => void
} {
  const store = createStore<{ error: string }>(() => ({ error: '' }))
  let pushed = false
  let active = true
  const unsubscribe = host.onState((state) => {
    pushed = true
    if (active) store.setState({ error: state.error }, true)
  })
  void host.getState().then(
    (state) => {
      if (active && !pushed) store.setState({ error: state.error }, true)
    },
    (error: unknown) => {
      if (active && !pushed) store.setState({ error: String(error) }, true)
    },
  )
  return {
    store,
    stop: () => {
      active = false
      unsubscribe()
    },
  }
}
