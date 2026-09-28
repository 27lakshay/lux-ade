import { QueryClient } from '@tanstack/react-query'
import type { ProfilesBridge } from '../../../shared/bridge/profiles'

// Server state fetched with TanStack Query. It all belongs to the selected profile's daemon.
export const queryClient = new QueryClient()

/** Drops every cached query when another profile is selected. Returns the unsubscribe function. */
export function clearOnProfileSwitch(profiles: ProfilesBridge, client: QueryClient = queryClient): () => void {
  let selected: string | null | undefined
  const unsubscribe = profiles.onState((state) => {
    if (selected !== undefined && state.selectedId !== selected) client.clear()
    selected = state.selectedId
  })
  void profiles.getState().then((state) => {
    selected ??= state.selectedId
  })
  return unsubscribe
}
