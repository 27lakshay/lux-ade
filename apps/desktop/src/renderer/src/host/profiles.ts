import type { ClientState } from '@ade/client'
import type { ProfileState } from '../types'

/** `window.adeHost.profiles`: the main-process `profiles` module and the profile connection. */
export interface ProfilesBridge {
  getState(): Promise<ProfileState>
  list(): Promise<ProfileState>
  create(name: string): Promise<ProfileState>
  select(id: string): Promise<ProfileState>
  onState(listener: (state: ProfileState) => void): () => void
  getClientState(): Promise<ClientState>
  onClientState(listener: (state: ClientState) => void): () => void
}
