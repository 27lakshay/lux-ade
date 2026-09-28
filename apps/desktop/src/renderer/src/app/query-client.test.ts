import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'vitest'
import type { ProfilesBridge } from '../../../shared/bridge/profiles'
import type { ProfileState } from '../../../shared/bridge/types'
import { clearOnProfileSwitch } from './query-client'

const state = (selectedId: string | null): ProfileState => ({
  managed: true,
  profiles: [],
  selectedId,
  activeId: selectedId,
  error: '',
})

test('cached queries are dropped when another profile is selected, and kept otherwise', async () => {
  let emit: (next: ProfileState) => void = () => undefined
  const profiles = {
    getState: () => Promise.resolve(state('a')),
    onState: (listener: (next: ProfileState) => void) => {
      emit = listener
      return () => undefined
    },
  } as unknown as ProfilesBridge
  const client = new QueryClient()
  clearOnProfileSwitch(profiles, client)
  await Promise.resolve()

  client.setQueryData(['workspaces'], ['one'])
  emit(state('a'))
  expect(client.getQueryData(['workspaces'])).toEqual(['one'])
  emit(state('b'))
  expect(client.getQueryData(['workspaces'])).toBeUndefined()
})
