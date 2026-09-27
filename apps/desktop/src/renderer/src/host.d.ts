import type { AdeHost } from '../../shared/bridge'

declare global {
  interface Window {
    adeHost: AdeHost
  }
}
