import type { Floor } from '../../worker/index.js'

declare global {
  namespace Cloudflare {
    interface Env {
      ASSETS: Fetcher
      CARPET_NETWORK: string
      CARPET_LOG_MODE: string
      FLOOR: DurableObjectNamespace<Floor>
    }
  }
}

export {}
