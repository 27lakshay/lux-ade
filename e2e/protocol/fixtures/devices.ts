// A fixture device host: PATH shims for `xcrun simctl`, and an Android SDK
// root whose `adb`, `emulator` and `aapt2` are shims, all served by
// `device_tools.py` from one `state.json`. Profiles started with `env()` see
// only these tools, so no spec reaches a real simulator, emulator, device or
// the user's Android SDK. Several profiles can share one fixture host, the
// way profiles share one physical machine.
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { scratchEnvironment } from './environment'

const script = join(__dirname, 'device_tools.py')

export type Simulator = {
  udid: string
  name: string
  /** The simctl runtime key suffix, such as `iOS-26-4` or `watchOS-11-0`. */
  runtime: string
  state: 'Booted' | 'Booting' | 'Shutdown' | 'Shutting Down'
  isAvailable?: boolean
  availabilityError?: string
}

export type AndroidDevice = {
  serial: string
  /** The `adb devices -l` state: `device`, `offline`, `unauthorized`, `no permissions`. */
  state: string
  avd?: string
  boot_completed?: boolean
  /** The rest of the `adb devices -l` line. */
  detail?: string
}

export type HoldKey =
  | 'bootstatus'
  | 'install'
  | 'launch'
  | 'adb-install'
  | 'am-start'
  | 'emulator'
  | 'adb-input'
  | 'idb-input'

export type DeviceHostState = {
  /** `missing` answers like xcrun without Simulator tools; `failed` like a broken CoreSimulator. */
  simctl?: 'ok' | 'missing' | 'failed'
  simulators: Simulator[]
  android: { devices: AndroidDevice[]; avds: string[]; apps?: Record<string, Record<string, unknown>> }
  holds?: Partial<Record<HoldKey, { phase: 'before' | 'after' }>>
  /** simctl launch prints no process ID. */
  launch_without_pid?: boolean
  /** simctl install reports this version instead of the bundle's. */
  install_reports_version?: string
  /** adb `input` prints this as a device-side `Error:` line. */
  input_error?: string
  /** simctl install leaves a container the daemon cannot read. */
  install_breaks_container?: boolean
  [key: string]: unknown
}

export type ToolCall = {
  tool: string
  args: string[]
  pid: number
  launched_pid?: number
  abandoned?: string
  /** An input event: the words after `input` (adb) or `ui` (idb), and the device it went to. */
  input?: string[]
  serial?: string
  udid?: string
}

/** Recorded sample identities. */
export const samples = {
  iphone: '5A4C9B7E-3D21-4F0A-8C6B-1E2D3F4A5B6C',
  ipad: 'BEB7852A-5E56-4A5E-9147-496AB6EB9396',
  noRuntime: '87915D21-DF21-41A4-BD5E-D76CAD1E899B',
  watch: '11111111-2222-3333-4444-555555555555',
}

/** A host with one shut-down and one booted iPhone, an iPad without a runtime, a watch, one AVD and adb devices in every state. */
export function sampleState(): DeviceHostState {
  return {
    simulators: [
      { udid: samples.iphone, name: 'iPhone 17 Pro', runtime: 'iOS-26-4', state: 'Shutdown' },
      { udid: samples.ipad, name: 'iPad Air', runtime: 'iOS-26-4', state: 'Booted' },
      {
        udid: samples.noRuntime,
        name: 'iPhone 16',
        runtime: 'iOS-18-2',
        state: 'Shutdown',
        isAvailable: false,
        availabilityError: 'runtime profile not found using "System" match policy',
      },
      { udid: samples.watch, name: 'Apple Watch Series 11', runtime: 'watchOS-11-0', state: 'Shutdown' },
    ],
    android: {
      avds: ['Pixel_9_Pro', 'Tablet_API_35'],
      devices: [
        {
          serial: 'emulator-5554',
          state: 'device',
          avd: 'Tablet_API_35',
          boot_completed: true,
          detail: 'product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
        },
        { serial: 'R58M123456', state: 'unauthorized', detail: 'usb:1-1 transport_id:2' },
        { serial: '0A1B2C3D', state: 'offline', detail: 'transport_id:3' },
        {
          serial: 'ZY22ABCDEF',
          state: 'no permissions',
          detail:
            '(user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:4',
        },
      ],
      apps: {},
    },
  }
}

export class DeviceHost {
  readonly bin: string
  readonly sdk: string
  private constructor(
    readonly dir: string,
    readonly tools: { xcrun: boolean; android: boolean; idb: boolean },
  ) {
    this.bin = join(dir, 'bin')
    this.sdk = join(dir, 'sdk')
  }

  /**
   * Create a fixture host under `root`. `tools` leaves out the Android SDK
   * shims to model a host without it, and `idb: false` leaves out simulator
   * input; xcrun is always a shim so the real one never runs (`simctl:
   * 'missing'` models a host without Xcode).
   */
  static async create(
    root: string,
    state: DeviceHostState = sampleState(),
    tools: { android?: boolean; idb?: boolean } = {},
  ): Promise<DeviceHost> {
    const host = new DeviceHost(join(root, 'device-host'), {
      xcrun: true,
      android: tools.android ?? true,
      idb: tools.idb ?? true,
    })
    const shims: Array<[string, string]> = [[join(host.bin, 'xcrun'), 'xcrun']]
    if (host.tools.idb) shims.push([join(host.bin, 'idb'), 'idb'])
    if (host.tools.android) {
      shims.push(
        [join(host.sdk, 'platform-tools/adb'), 'adb'],
        [join(host.sdk, 'emulator/emulator'), 'emulator'],
        [join(host.sdk, 'build-tools/35.0.0/aapt2'), 'aapt2'],
      )
    } else {
      await mkdir(host.sdk, { recursive: true })
    }
    for (const [path, tool] of shims) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, `#!/bin/sh\nexec python3 '${script}' ${tool} '${host.dir}' "$@"\n`)
      await chmod(path, 0o755)
    }
    await host.write(state)
    await writeFile(join(host.dir, 'calls.jsonl'), '')
    return host
  }

  /** Daemon environment that resolves device tools to this host's shims. */
  env(): Record<string, string> {
    const inherited = scratchEnvironment(this.dir).PATH
    return { PATH: `${this.bin}:${inherited}`, ANDROID_HOME: this.sdk, ANDROID_SDK_ROOT: this.sdk }
  }

  path(tool: 'xcrun' | 'idb' | 'adb' | 'emulator' | 'aapt2'): string {
    return {
      xcrun: join(this.bin, 'xcrun'),
      idb: join(this.bin, 'idb'),
      adb: join(this.sdk, 'platform-tools/adb'),
      emulator: join(this.sdk, 'emulator/emulator'),
      aapt2: join(this.sdk, 'build-tools/35.0.0/aapt2'),
    }[tool]
  }

  async state(): Promise<DeviceHostState> {
    return JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')) as DeviceHostState
  }

  async write(state: DeviceHostState): Promise<void> {
    await writeFile(join(this.dir, 'state.json'), JSON.stringify(state, null, 2))
  }

  /** Change the host between steps, such as unplugging a device. */
  async update(change: (state: DeviceHostState) => void): Promise<void> {
    const state = await this.state()
    change(state)
    await this.write(state)
  }

  /** Every effect the shims performed, in order. */
  async calls(tool?: string, action?: string): Promise<ToolCall[]> {
    const text = await readFile(join(this.dir, 'calls.jsonl'), 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ToolCall)
      .filter((call) => (!tool || call.tool === tool) && (!action || call.args.includes(action)))
  }

  /** Pause the next `key` action; `after` applies the effect first. */
  async hold(key: HoldKey, phase: 'before' | 'after' = 'before'): Promise<void> {
    await rm(join(this.dir, `held-${key}`), { force: true })
    await rm(join(this.dir, `release-${key}`), { force: true })
    await this.update((state) => {
      state.holds = { ...state.holds, [key]: { phase } }
    })
  }

  /** Resolves once a shim is paused at `key`. */
  async held(key: HoldKey): Promise<void> {
    await expect
      .poll(
        () =>
          readFile(join(this.dir, `held-${key}`), 'utf8').then(
            () => true,
            () => false,
          ),
        { timeout: 20_000 },
      )
      .toBe(true)
  }

  async release(key: HoldKey): Promise<void> {
    await writeFile(join(this.dir, `release-${key}`), '')
  }

  /** A built simulator app: a `.app` directory with a real Info.plist. */
  async app(name: string, bundleId: string, version: string): Promise<string> {
    const path = join(this.dir, 'apps', `${name}.app`)
    await mkdir(path, { recursive: true })
    await writeFile(
      join(path, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>${name}</string>
</dict>
</plist>
`,
    )
    return path
  }

  /** An APK stand-in the aapt2 and adb shims read. */
  async apk(name: string, packageName: string, versionCode: string): Promise<string> {
    const path = join(this.dir, 'apps', `${name}.apk`)
    await mkdir(join(this.dir, 'apps'), { recursive: true })
    await writeFile(path, JSON.stringify({ package: packageName, versionCode, activity: '.MainActivity' }))
    return path
  }
}
