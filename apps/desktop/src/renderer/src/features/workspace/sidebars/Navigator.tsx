import { useQuery } from '@tanstack/react-query'
import { IconButton } from '@/components/IconButton'
import { interactive } from '@/components/interactive'
import { Row } from '@/components/Row'
import { Shortcut } from '@/components/Shortcut'
import { Caption, Text } from '@/components/Typography'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { Icon } from '@/icons/Icon'
import { openTab } from '../model/layout-store'

// The navigator sidebar: the profile, starting a conversation, and (later) projects, workspaces
// and conversations. Its first row lines up with the other cards' top rows.

function ProfileSwitcher() {
  const { data } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => window.adeHost.profiles.getState(),
    enabled: Boolean(window.adeHost),
  })
  const name = data?.profiles.find((profile) => profile.id === data.selectedId)?.name ?? 'Profile'
  return (
    <button type="button" className={cn(interactive, 'flex h-9 w-full items-center gap-2 rounded-sm px-2')}>
      <span className="flex size-5 items-center justify-center rounded-sm bg-muted">
        <Caption weight="semibold">{name.charAt(0).toUpperCase()}</Caption>
      </span>
      <Text weight="semibold" truncate className="min-w-0 flex-1 text-start">
        {name}
      </Text>
      <Icon name="select" size="sm" tone="muted" />
    </button>
  )
}

export function Navigator() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 px-1.5 pt-0.5 pb-1">
      <ProfileSwitcher />
      <Row
        leading={<Icon name="newConversation" tone="muted" />}
        trailing={<Shortcut appCommand="new-conversation" />}
        onClick={() => openTab({ kind: 'conversation', title: 'New conversation' })}
      >
        New conversation
      </Row>
      <ScrollArea className="min-h-0 flex-1" />
      <div className="flex h-10 shrink-0 items-center">
        <IconButton icon="addProject" label="Add project" onClick={() => void window.adeHost?.workspaces.choose()} />
      </div>
    </div>
  )
}
