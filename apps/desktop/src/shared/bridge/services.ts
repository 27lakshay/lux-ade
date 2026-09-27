import type { Frame } from './types'

/** `window.adeHost.services`: the main-process `services` module (managed services and scripts). */
export interface ServicesBridge {
  request(op: string, fields: Record<string, unknown>): Promise<Frame>
  requestScript(op: string, fields: Record<string, unknown>): Promise<Frame>
}
