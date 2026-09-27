import { useEffect, useState } from 'react'

// Dev-panel settings survive relaunches in localStorage (Electron keeps it in the app's data
// folder). Storage can be unavailable or hold stale shapes, so every read and write falls back
// quietly to the default.
const PREFIX = 'ade.dev.'

export function readPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readPersisted(key, fallback))
  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
      // Not persisted this time; the in-memory value still applies.
    }
  }, [key, value])
  return [value, setValue] as const
}
