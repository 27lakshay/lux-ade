import React from 'react'
import { createRoot } from 'react-dom/client'
import type { ClientState, Workspace, Conversation } from '@ade/client'
import { ReviewPane } from './review'
import { BrowserPane } from './browser'
import { ScriptPane } from './scripts'
import { FilesPane } from './files'
import { ServicePane } from './services'
import { TerminalPane } from './terminal'
import { ConversationView } from './conversation'
import { RestoreBindingsPanel } from './restore'
import { AccountsPanel } from './accounts'
import type { Account, AccountConversation, PendingSend, ProfileState, Provider } from './types'
import './style.css'

function ConnectedContent({ state, profileKey }: { state: ClientState; profileKey: string }): React.JSX.Element {
  const workspaces = state.catalog?.workspaces ?? []
  const conversations = state.catalog?.conversations ?? []
  const workspaceStorageKey = `ade.lastWorkspace.${profileKey}`
  const conversationStorageKey = `ade.lastConversation.${profileKey}`
  const [workspaceId, setWorkspaceId] = React.useState(() => localStorage.getItem(workspaceStorageKey) ?? '')
  const [conversationId, setConversationId] = React.useState(() => localStorage.getItem(conversationStorageKey) ?? '')
  const [provider, setProvider] = React.useState('codex')
  const [providers, setProviders] = React.useState<Provider[]>([])
  const [accounts, setAccounts] = React.useState<Account[]>([])
  const [managedAccountId, setManagedAccountId] = React.useState('')
  const [folderPath, setFolderPath] = React.useState('')
  const [effectiveUnboundIds, setEffectiveUnboundIds] = React.useState<string[]>([])
  const [opening, setOpening] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [pendingCreatedId, setPendingCreatedId] = React.useState<string | null>(null)
  const [acknowledgedSelection, setAcknowledgedSelection] = React.useState('')
  const selectionSequence = React.useRef(0)
  const visibleSelectionRequest = React.useRef(0)
  const [error, setError] = React.useState('')
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0]
  const workspaceFenced = Boolean(workspace?.needs_rebind || workspace?.worktree_lifecycle_needs_rebind ||
    (workspace && effectiveUnboundIds.includes(workspace.id)))
  const workspaceConversations = conversations.filter((item) => item.workspace_id === workspace?.id)
  const selectedConversation = workspaceConversations.find((item) => item.id === conversationId)
  const awaitingCreated = pendingCreatedId === conversationId && !selectedConversation
  const conversation = awaitingCreated ? undefined : selectedConversation ?? workspaceConversations[0]
  const targetConversationId = awaitingCreated ? pendingCreatedId : conversation?.id ?? null
  const selectionKey = workspace ? `${workspace.id}:${targetConversationId ?? ''}` : ''
  React.useEffect(() => {
    if (!workspace) return
    const sequence = ++selectionSequence.current
    void window.adeHost.selectWorkspace(workspace.id, targetConversationId).then(() => {
      if (sequence === selectionSequence.current) setAcknowledgedSelection(selectionKey)
    }).catch((reason) => { if (sequence === selectionSequence.current) setError(String(reason)) })
    return () => { selectionSequence.current++ }
  }, [workspace?.id, targetConversationId, state.bootId])
  const selectVisible = async (workspaceId: string, nextConversationId: string | null): Promise<void> => {
    const request = ++visibleSelectionRequest.current
    ++selectionSequence.current
    await window.adeHost.selectWorkspace(workspaceId, nextConversationId)
    if (request !== visibleSelectionRequest.current) return
    setAcknowledgedSelection(`${workspaceId}:${nextConversationId ?? ''}`)
    setWorkspaceId(workspaceId)
    localStorage.setItem(workspaceStorageKey, workspaceId)
    setConversationId(nextConversationId ?? '')
    localStorage.setItem(conversationStorageKey, nextConversationId ?? '')
  }
  React.useEffect(() => {
    if (pendingCreatedId && conversations.some((item) => item.id === pendingCreatedId)) setPendingCreatedId(null)
  }, [pendingCreatedId, conversations])
  React.useEffect(() => {
    let disposed = false
    void window.adeHost.requestConversation('provider.list', {}).then((response) => {
      if (disposed || !Array.isArray(response.providers)) return
      const found = response.providers.filter((item): item is Provider =>
        typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.name === 'string')
      setProviders(found)
      if (found.length && !found.some((item) => item.id === provider)) setProvider(found[0].id)
    }).catch((reason) => { if (!disposed) setError(String(reason)) })
    return () => { disposed = true }
  }, [state.bootId])
  const selectedManagedAccount = accounts.find((item) => item.id === managedAccountId && item.provider === provider && item.state === 'verified')
  const invalidManagedAccount = Boolean(managedAccountId && !selectedManagedAccount)
  const accountLabel = (item: Conversation): string => {
    const pinned = item as AccountConversation
    if (!pinned.account_id) return 'Legacy ambient account'
    return `Account: ${accounts.find((account) => account.id === pinned.account_id)?.name ?? pinned.account_id}`
  }
  const create = async (): Promise<void> => {
    if (!workspace || workspaceFenced || creating || opening || invalidManagedAccount) return
    setCreating(true)
    try {
      const response = await window.adeHost.requestConversation('conversation.create', {
        workspace_id: workspace.id, title: 'New Conversation', provider,
        ...(selectedManagedAccount ? { account_id: selectedManagedAccount.id } : {}),
      })
      const created = response.conversation as Conversation
      await selectVisible(workspace.id, created.id)
      setPendingCreatedId(created.id)
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setCreating(false) }
  }
  const openFolder = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (opening || creating || !folderPath.trim()) return
    setOpening(true)
    try {
      const result = await window.adeHost.openWorkspace(folderPath.trim())
      const opened = result.workspace as Workspace
      await selectVisible(opened.id, null)
      setFolderPath('')
      setError('')
    } catch (reason) { setError(String(reason)) }
    finally { setOpening(false) }
  }
  const chooseFolder = async (): Promise<void> => {
    if (opening || creating) return
    setOpening(true)
    try {
      const result = await window.adeHost.chooseWorkspace()
      if (result) {
        const opened = result.workspace as Workspace
        await selectVisible(opened.id, null)
        setError('')
      }
    } catch (reason) { setError(String(reason)) }
    finally { setOpening(false) }
  }
  return (
    <div className="workspace-layout">
      <aside className="sidebar" aria-label="Workspace navigation">
        <h1>Workspaces</h1>
        <p className="connection-meta">Daemon boot: {state.bootId}</p>
        {workspaces.length === 0 && <p>No workspaces are registered in this profile yet.</p>}
        {workspaces.length > 0 && <label className="field-label" htmlFor="workspace">Workspace</label>}
        {workspaces.length > 0 && <select id="workspace" value={workspace?.id} disabled={creating || opening} onChange={(event) => {
          const nextId = event.target.value
          const firstConversation = conversations.find((item) => item.workspace_id === nextId)
          void selectVisible(nextId, firstConversation?.id ?? null).catch((reason) => setError(String(reason)))
        }}>
          {workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>}
        {workspace && <><p className="workspace-kind">{workspace.repository_id ? 'Git project' : 'Folder'}</p>
          <p className="workspace-root" title={workspace.root}>{workspace.root}</p>
          {(workspace.needs_rebind || effectiveUnboundIds.includes(workspace.id)) &&
            <p role="alert" className="inline-error">Workspace or repository binding is missing, replaced or awaiting rebind. Verify its path before using it.</p>}
          {workspace.worktree_lifecycle_needs_rebind &&
            <p role="alert" className="inline-error">Worktree lifecycle binding needs recovery before this workspace can run.</p>}
        </>}
        <RestoreBindingsPanel bootId={state.bootId} profileKey={profileKey} onWorkspaceBindings={setEffectiveUnboundIds} />
        <form className="open-workspace" onSubmit={(event) => void openFolder(event)}>
          <label className="field-label" htmlFor="folder-path">Open folder</label>
          <input id="folder-path" value={folderPath} placeholder="/path/to/project" onChange={(event) => setFolderPath(event.target.value)} />
          <div><button type="submit" disabled={opening || creating || !folderPath.trim()}>Open folder</button>
            <button type="button" disabled={opening || creating} onClick={() => void chooseFolder()}>Browse…</button></div>
        </form>
        <h2>Conversations</h2>
        <nav aria-label="Conversations"><ul className="conversation-list">
          {workspaceConversations.map((item) => <li key={item.id}><button disabled={creating || opening} className={conversation?.id === item.id ? 'selected' : ''} onClick={() => {
            if (workspace) void selectVisible(workspace.id, item.id).catch((reason) => setError(String(reason)))
          }}>{item.title}<small>{item.provider} · {accountLabel(item)} · {item.status}</small></button></li>)}
        </ul></nav>
        <div className="new-conversation">
          <label className="field-label" htmlFor="provider">New conversation provider</label>
          <select id="provider" value={provider} disabled={creating || opening} onChange={(event) => {
            setProvider(event.target.value); setManagedAccountId('')
          }}>
            {providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
          <label className="field-label" htmlFor="conversation-account">New conversation account</label>
          <select id="conversation-account" value={managedAccountId} disabled={creating || opening}
            onChange={(event) => setManagedAccountId(event.target.value)}>
            <option value="">Legacy ambient account</option>
            {invalidManagedAccount && <option value={managedAccountId} disabled>Account unavailable — choose an account</option>}
            {accounts.filter((item) => item.provider === provider && item.state === 'verified').map((item) =>
              <option value={item.id} key={item.id}>{item.name} · managed</option>)}
          </select>
          {invalidManagedAccount && <p role="alert" className="inline-error">Selected account is unavailable. Choose another account or the legacy ambient account.</p>}
          <button disabled={creating || opening || workspaceFenced || invalidManagedAccount || !workspace || providers.length === 0} onClick={() => void create()}>New conversation</button>
        </div>
        <AccountsPanel bootId={state.bootId} accounts={accounts} onAccounts={setAccounts} />
        {error && <p role="alert" className="inline-error">{error}</p>}
      </aside>
      <div className="work-area">
        {creating || awaitingCreated ? <section className="empty-conversation" role="status">Creating conversation…</section>
          : conversation ? <ConversationView key={conversation.id} conversation={conversation} bootId={state.bootId}
            accountLabel={accountLabel(conversation)} fenced={workspaceFenced} />
          : <section className="empty-conversation"><h2>Start a conversation</h2><p>Choose a provider and create a conversation in this workspace.</p></section>}
        {workspace && !workspaceFenced && <>{acknowledgedSelection === selectionKey && <><FilesPane key={`files:${profileKey}:${workspace.id}`} workspace={workspace} /><ReviewPane key={`${profileKey}:${workspace.id}:${conversation?.id ?? ''}`}
          workspace={workspace} conversation={conversation} profileKey={profileKey} /></>}
          <ServicePane key={`${state.bootId}:${workspace.id}`} workspace={workspace} /><ScriptPane key={`scripts:${workspace.id}`} workspace={workspace} /><TerminalPane workspace={workspace} /></>}
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  const [state, setState] = React.useState<ClientState | null>(null)
  const [profile, setProfile] = React.useState<ProfileState | null>(null)
  const [newProfile, setNewProfile] = React.useState('')
  const [profileBusy, setProfileBusy] = React.useState(false)
  const [profileError, setProfileError] = React.useState('')
  const [requestedProfileId, setRequestedProfileId] = React.useState<string | null>(null)
  const [pendingSends, setPendingSends] = React.useState<PendingSend[]>([])
  const [pendingSendError, setPendingSendError] = React.useState('')
  const activeProfileId = React.useRef<string | null>(null)
  React.useEffect(() => {
    const unsubscribeClient = window.adeHost.onClientState(setState)
    const refreshClient = (profileId: string | null): void => {
      void window.adeHost.getClientState().then((next) => {
        if (activeProfileId.current === profileId) setState(next)
      })
    }
    const updateProfile = (next: ProfileState): void => {
      if (activeProfileId.current !== next.activeId) {
        activeProfileId.current = next.activeId
        setState(null)
        refreshClient(next.activeId)
      }
      setProfile(next)
    }
    let profileEventSeen = false
    const unsubscribeProfile = window.adeHost.onProfileState((next) => {
      profileEventSeen = true
      updateProfile(next)
    })
    void window.adeHost.getProfileState().then((next) => { if (!profileEventSeen) updateProfile(next) })
    const initialProfileId = activeProfileId.current
    refreshClient(initialProfileId)
    return () => { unsubscribeClient(); unsubscribeProfile() }
  }, [])
  React.useEffect(() => {
    let active = true
    void window.adeHost.listPendingSends().then((records) => {
      if (active) { setPendingSends(records); setPendingSendError('') }
    }).catch((error) => { if (active) setPendingSendError(String(error)) })
    return () => { active = false }
  }, [state?.status, profile?.activeId])
  const switchProfile = async (id: string): Promise<void> => {
    if (!id || profileBusy || id === profile?.activeId) return
    setRequestedProfileId(id)
    setProfileError('')
    setProfileBusy(true)
    try { await window.adeHost.selectProfile(id); setProfileError(''); setRequestedProfileId(null) }
    catch (error) { setProfileError(String(error)) }
    finally { setProfileBusy(false) }
  }
  const createProfile = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const name = newProfile.trim()
    if (!name || profileBusy) return
    setRequestedProfileId(null)
    setProfileError('')
    setProfileBusy(true)
    try {
      const priorIds = new Set(profile?.profiles.map((item) => item.id))
      const next = await window.adeHost.createProfile(name)
      const created = next.profiles.find((item) => !priorIds.has(item.id))
      if (!created) throw new Error('Created profile was not returned by the launcher')
      setRequestedProfileId(created.id)
      await window.adeHost.selectProfile(created.id)
      setNewProfile('')
      setProfileError('')
      setRequestedProfileId(null)
    } catch (error) { setProfileError(String(error)) }
    finally { setProfileBusy(false) }
  }
  const active = profile?.profiles.find((item) => item.id === profile.activeId)
  const ownershipError = (profileError || profile?.error || '').includes('Browser session ownership is unverified')
  const adoptionProfileId = requestedProfileId ?? (profile?.activeId ? null : profile?.selectedId)
  const adoptionProfile = profile?.profiles.find((item) => item.id === adoptionProfileId)
  const adoptBrowserSession = async (): Promise<void> => {
    if (!ownershipError || !adoptionProfile || profileBusy) return
    const warning = `The original owner of this browser session cannot be proven.\n\nAdopting it for ${adoptionProfile.name} (${adoptionProfile.id}) could attach another profile's cookies. Continue?`
    if (!window.confirm(warning)) return
    setProfileBusy(true)
    try {
      const next = await window.adeHost.adoptBrowserSession(adoptionProfile.id)
      setProfile(next)
      setProfileError('')
      setRequestedProfileId(null)
    } catch (error) { setProfileError(String(error)) }
    finally { setProfileBusy(false) }
  }
  return <main><header><span className="brand">ADE</span><div className="header-controls">
    {profile?.managed && <label className="profile-picker">Profile <select aria-label="Profile" value={profile.activeId ?? ''}
      disabled={profileBusy} onChange={(event) => void switchProfile(event.target.value)}>
      <option value="">Choose profile</option>
      {profile.profiles.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></label>}
    <span className="status" role="status">{state?.status ?? 'connecting'}</span></div></header>
    {profile?.managed && <div className="profile-bar">
      <span>{active ? `Active profile: ${active.name}` : 'No active profile'}</span>
      <form onSubmit={(event) => void createProfile(event)}><label htmlFor="new-profile">New profile</label>
        <input id="new-profile" value={newProfile} maxLength={80} onChange={(event) => setNewProfile(event.target.value)} placeholder="Profile name" />
        <button type="submit" disabled={profileBusy || !newProfile.trim()}>Create</button></form>
      {(profileError || profile.error) && <span role="alert" className="inline-error">{profileError || profile.error}</span>}
      {ownershipError && adoptionProfile && <div>
        <p>The original owner of this browser session cannot be proven. Adopting it could attach another profile&apos;s cookies.</p>
        <button type="button" disabled={profileBusy} onClick={() => void adoptBrowserSession()}>Adopt unverified browser session</button>
      </div>}
    </div>}
    {state?.status !== 'connected' && (pendingSends.length > 0 || pendingSendError) &&
      <section aria-label="Pending prompts" className="account-panel">
        <h2>Pending prompts</h2>
        <p>These prompts are saved for recovery. Reconnect their original profile before retrying delivery.</p>
        {pendingSendError && <p role="alert">{pendingSendError}</p>}
        {pendingSends.map((item) => <article key={`${item.profileId}:${item.conversationId}:${item.requestId}`}>
          <p>Profile {item.profileId} · Conversation {item.conversationId}</p>
          <p>Request {item.requestId}</p><pre>{item.text}</pre>
        </article>)}
      </section>}
    {state?.status === 'connected' ? <ConnectedContent key={profile?.activeId ?? 'fixed'} profileKey={profile?.activeId ?? 'fixed'} state={state} /> : <section className="welcome">
      <h1>Work across agents, in one place.</h1><p role="status">{state?.detail ?? 'Checking profile daemon…'}</p>
    </section>}
    {(profile?.activeId || !profile?.managed) && <BrowserPane key={`browser:${profile?.activeId ?? 'fixed'}`} profileId={profile?.activeId ?? 'fixed'} />}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
