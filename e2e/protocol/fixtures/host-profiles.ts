// Managed scratch profiles that share one host. `ade-control` gives every
// managed profile the runtime home `<profiles home>/profiles/<uuid>/runtime`,
// and the daemon puts the host-wide HostResources registry in that profiles
// home. These helpers give scratch profiles the same layout under the test's
// temp root, so their daemons coordinate through one registry exactly as
// managed profiles on a real host do.
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdeHarness } from './index'
import type { ProfileOptions, ScratchProfile } from './profile'

/** The runtime home a managed profile with `id` gets under `profilesHome`. */
export function managedRuntimeHome(profilesHome: string, id: string = randomUUID()): string {
  return join(profilesHome, 'profiles', id, 'runtime')
}

/**
 * Start `count` profiles that share one host registry under the test's temp
 * root. Each gets its own profile UUID, data directory, sockets and HOME.
 */
export async function startHostProfiles(
  ade: AdeHarness,
  count: number,
  options: ProfileOptions = {},
): Promise<{ profilesHome: string; profiles: ScratchProfile[] }> {
  const profilesHome = join(ade.root, 'host')
  const profiles: ScratchProfile[] = []
  for (let index = 0; index < count; index++) {
    const runtimeHome = managedRuntimeHome(profilesHome)
    await mkdir(runtimeHome, { recursive: true, mode: 0o700 })
    profiles.push(await ade.profile({ ...options, env: { ...options.env, ADE_RUNTIME_HOME: runtimeHome } }))
  }
  return { profilesHome, profiles }
}
