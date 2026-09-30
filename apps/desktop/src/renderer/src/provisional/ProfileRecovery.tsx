import { useStore } from 'zustand'
import type { ReactNode } from 'react'
import { Body } from '@/components/Typography'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { ProfileStore } from '../state/profile-store'
import { FullScreen } from './FullScreen'

export function ProfileRecovery({ store, children }: { store: ProfileStore; children?: ReactNode }) {
  const error = useStore(store, (state) => state.error)
  return (
    <>
      <div hidden={Boolean(error)} className="h-full">
        {children}
      </div>
      {error && (
        <FullScreen title="Profile unavailable">
          <Alert variant="destructive">
            <AlertTitle>ADE could not connect to this profile</AlertTitle>
            <AlertDescription>
              <Body tone="inherit">{error}</Body>
              <Body tone="inherit">
                Resolve this error before reopening the profile. Keep any existing daemon running and use a compatible
                ADE version.
              </Body>
            </AlertDescription>
          </Alert>
        </FullScreen>
      )}
    </>
  )
}
