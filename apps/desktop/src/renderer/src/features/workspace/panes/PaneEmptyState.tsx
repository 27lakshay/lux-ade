import { Row } from '@/components/Row'
import { Shortcut } from '@/components/Shortcut'
import { Caption, Text } from '@/components/Typography'
import { Icon } from '@/icons/Icon'
import { openTab } from '../model/layout-store'
import { TAB_ICON } from './Tab'

// The body of a pane with nothing open: what can be started here, with the keys for each.
export function PaneEmptyState({ paneId }: { paneId: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <div className="flex flex-col items-center gap-1.5">
        <Text weight="medium">Nothing open in this pane</Text>
        <Caption tone="muted">Start something, or drag a tab here.</Caption>
      </div>
      <div className="flex w-60 flex-col gap-0.5">
        <Row
          leading={<Icon name={TAB_ICON.conversation} tone="muted" />}
          trailing={<Shortcut appCommand="new-conversation" />}
          onClick={() => openTab({ kind: 'conversation', title: 'New conversation' }, paneId)}
        >
          New conversation
        </Row>
        <Row
          leading={<Icon name={TAB_ICON.terminal} tone="muted" />}
          onClick={() => openTab({ kind: 'terminal', title: 'Terminal' }, paneId)}
        >
          New terminal
        </Row>
        <Row
          leading={<Icon name={TAB_ICON.browser} tone="muted" />}
          onClick={() => openTab({ kind: 'browser', title: 'Browser' }, paneId)}
        >
          Open browser
        </Row>
      </div>
    </div>
  )
}
