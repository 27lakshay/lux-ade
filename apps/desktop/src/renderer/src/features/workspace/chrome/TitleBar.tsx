import { IconButton } from '@/components/IconButton'
import { openCommandPalette } from '../../../provisional/CommandPalette'
import { toggleSide } from '../model/layout-store'

// The fixed top row: the window buttons (native), the sidebar toggles and search. The whole row
// drags the window except its controls.
export function TitleBar() {
  return (
    <header className="drag flex h-(--titlebar-height) shrink-0 items-center gap-1 bg-sidebar ps-(--traffic-lights-inset) pe-2">
      <IconButton
        icon="toggleLeftSidebar"
        label="Toggle left sidebar"
        shortcut={{ appCommand: 'toggle-left-sidebar' }}
        onClick={() => toggleSide('left')}
      />
      <div className="flex-1" />
      <IconButton
        icon="search"
        label="Search"
        shortcut={{ appCommand: 'command-palette' }}
        onClick={openCommandPalette}
      />
      <IconButton
        icon="toggleRightSidebar"
        label="Toggle right sidebar"
        shortcut={{ appCommand: 'toggle-right-sidebar' }}
        onClick={() => toggleSide('right')}
      />
    </header>
  )
}
