import { BottomBar } from './chrome/BottomBar'
import { Rail } from './chrome/Rail'
import { TitleBar } from './chrome/TitleBar'
import { CardArea } from './cards/CardArea'

// The workspace screen: fixed chrome (title bar, rail, bottom bar) around the floating cards.
export function Workspace() {
  return (
    <div className="flex h-full flex-col bg-base text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <CardArea />
      </div>
      <BottomBar />
    </div>
  )
}
