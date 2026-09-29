import { Row } from '@/components/Row'
import { Shortcut } from '@/components/Shortcut'
import { Caption, Text } from '@/components/Typography'
import { Icon } from '@/icons/Icon'
import { nanoid } from 'nanoid'
import { openTab } from '../model/layout-store'
import { newTerminal } from '../terminals/terminal-tabs'
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
          onClick={() => void openTab({ kind: 'new_conversation' }, paneId)}
        >
          New conversation
        </Row>
        <Row leading={<Icon name={TAB_ICON.terminal} tone="muted" />} onClick={() => void newTerminal(paneId)}>
          New terminal
        </Row>
        <Row
          leading={<Icon name={TAB_ICON.browser} tone="muted" />}
          // Browser tabs have no daemon records yet (ticket 09): the tab names a page to come.
          onClick={() => void openTab({ kind: 'browser', id: `browser-${nanoid(8)}` }, paneId)}
        >
          Open browser
        </Row>
      </div>
    </div>
  )
}
