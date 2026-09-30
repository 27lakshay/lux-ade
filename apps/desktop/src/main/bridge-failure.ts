import { DaemonRequestError, ThemeFileExportError } from '@ade/client'
import type { BridgeFailure } from '../shared/bridge/result'

export function bridgeFailure(error: unknown): BridgeFailure {
  if (error instanceof DaemonRequestError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      delivery: error.delivery,
      replied: error.replied,
      recovery: error.recovery,
      details: error.details,
      operationId: error.operationId,
    }
  }
  if (error instanceof ThemeFileExportError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      delivery: 'not_sent',
      replied: false,
      details: {},
    }
  }
  return {
    name: 'Error',
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    // An unexpected exception can occur after an authoritative command; do not claim it was unsent.
    delivery: 'unknown',
    replied: false,
    details: {},
  }
}
