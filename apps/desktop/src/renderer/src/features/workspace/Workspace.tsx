import { Title } from '@/components/Typography'

// The workspace screen. The UI is being rebuilt from scratch; for now it only proves the app renders.
export function Workspace() {
  return (
    <main className="drag flex h-full items-center justify-center">
      <Title as="h1">Hello world</Title>
    </main>
  )
}
