import { BottomBar } from './chrome/BottomBar'
import { Rail } from './chrome/Rail'
import { TitleBar } from './chrome/TitleBar'
import { CardArea } from './cards/CardArea'
import { ContentHosts, type RenderContent } from './content/ContentHosts'

// The workspace screen: fixed chrome (title bar, rail, bottom bar) around the floating cards, and
// the content hosts, which render every tab's content once for panes to attach.
export function Workspace({ renderContent }: { renderContent?: RenderContent }) {
  return (
    <div className="flex h-full flex-col bg-base text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <CardArea />
      </div>
      <BottomBar />
      <ContentHosts render={renderContent} />
    </div>
  )
}
