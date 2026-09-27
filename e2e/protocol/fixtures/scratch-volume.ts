// A disposable disk volume for storage-exhaustion tests (R004). It is a small
// HFS+ disk image under the test's temp root, attached with hdiutil at a path
// the test chooses, such as a profile's data directory before the profile
// starts. `fill` writes one file until the volume reports it is full; `free`
// removes it. Nothing here touches any other volume.
//
// The image must be detached after every process using it has stopped. Use
// `volumeTest` below: its fixture stops the profile registered with `use`
// first, then detaches, whether the test passed or failed.
import { execFile } from 'node:child_process'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test as base, type ScratchProfile } from './index'

const run = promisify(execFile)

export class ScratchVolume {
  private profiles: ScratchProfile[] = []
  private readonly filler: string

  private constructor(
    readonly image: string,
    readonly mountPoint: string,
  ) {
    this.filler = join(mountPoint, 'filler.bin')
  }

  /** Create a `sizeMb` image in `directory` and attach it at `mountPoint`. */
  static async attach(directory: string, mountPoint: string, sizeMb = 64): Promise<ScratchVolume> {
    const image = join(directory, 'scratch-volume.dmg')
    await run('hdiutil', [
      'create',
      '-quiet',
      '-size',
      `${sizeMb}m`,
      '-fs',
      'HFS+',
      '-volname',
      'ade-e2e',
      '-type',
      'UDIF',
      '-layout',
      'NONE',
      image,
    ])
    await mkdir(mountPoint, { recursive: true })
    await run('hdiutil', [
      'attach',
      '-quiet',
      '-nobrowse',
      '-noverify',
      '-noautoopen',
      '-owners',
      'on',
      '-mountpoint',
      mountPoint,
      image,
    ])
    return new ScratchVolume(image, mountPoint)
  }

  /** Stop `profile` before the volume is detached. */
  use(profile: ScratchProfile): void {
    this.profiles.push(profile)
  }

  /** Write until the volume reports ENOSPC. Returns the bytes written. */
  async fill(): Promise<number> {
    const file = await open(this.filler, 'a')
    const chunk = Buffer.alloc(1024 * 1024, 0x61)
    let written = 0
    try {
      for (;;) {
        try {
          const { bytesWritten } = await file.write(chunk)
          written += bytesWritten
          if (bytesWritten < chunk.length) break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOSPC') break
          throw error
        }
      }
      // Take the last partial blocks as well.
      for (let size = 64 * 1024; size >= 512; size /= 2) {
        try {
          written += (await file.write(Buffer.alloc(size, 0x61))).bytesWritten
        } catch {
          /* Full at this size. */
        }
      }
    } finally {
      await file.close().catch(() => undefined)
    }
    return written
  }

  async free(): Promise<void> {
    await rm(this.filler, { force: true })
  }

  async detach(): Promise<void> {
    for (const profile of this.profiles) await profile.stop().catch(() => undefined)
    await run('hdiutil', ['detach', '-force', this.mountPoint]).catch(() => undefined)
  }
}

/** `test` with a `volume(mountPoint)` fixture that attaches a scratch volume and detaches it afterwards. */
export const volumeTest = base.extend<{ volume: (mountPoint: string, sizeMb?: number) => Promise<ScratchVolume> }>({
  volume: async ({ ade }, use, testInfo) => {
    // hdiutil talks to system disk services. System-service specs are opt-in and
    // run serially (AGENTS.md, machine safety).
    testInfo.skip(process.env.ADE_E2E_SYSTEM !== '1', 'system-service spec: set ADE_E2E_SYSTEM=1 and run it alone')
    const volumes: ScratchVolume[] = []
    await use(async (mountPoint, sizeMb) => {
      const volume = await ScratchVolume.attach(ade.root, mountPoint, sizeMb)
      volumes.push(volume)
      return volume
    })
    for (const volume of volumes) await volume.detach()
  },
})
