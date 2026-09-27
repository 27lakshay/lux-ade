import React from 'react'
import type { Account, AccountIdentity, AccountInspection } from './types'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
function accountIdentityLabel(identity: AccountIdentity): string {
  if ('credential_id' in identity) {
    return `${identity.email ?? identity.account_id ?? identity.identity_key} · ${identity.provider} OAuth credential ${identity.credential_id}`
  }
  if ('chatgpt_account_id' in identity) return `${identity.email} · ChatGPT account ${identity.chatgpt_account_id}`
  return `${identity.email} · organization ${identity.org_id} · ${identity.auth_method} / ${identity.api_provider}`
}

export function AccountsPanel({ bootId, accounts, onAccounts }: {
  bootId: string | null; accounts: Account[]; onAccounts: (accounts: Account[]) => void
}): React.JSX.Element {
  const [accountProvider, setAccountProvider] = React.useState<'claude' | 'codex' | 'omp'>('claude')
  const [accountName, setAccountName] = React.useState('')
  const [accountId, setAccountId] = React.useState('')
  const [inspection, setInspection] = React.useState<{ accountId: string; value: AccountInspection; generation: number } | null>(null)
  const [accountBusy, setAccountBusy] = React.useState(false)
  const [accountError, setAccountError] = React.useState('')
  const refreshAccounts = async (): Promise<Account[]> => {
    const response = await window.adeHost.conversations.request('account.list', {})
    const found = Array.isArray(response.accounts) ? response.accounts as Account[] : []
    onAccounts(found)
    setInspection(null)
    return found
  }
  React.useEffect(() => {
    let disposed = false
    void window.adeHost.conversations.request('account.list', {}).then((response) => {
      if (!disposed && Array.isArray(response.accounts)) onAccounts(response.accounts as Account[])
    }).catch((reason) => { if (!disposed) setAccountError(String(reason)) })
    return () => { disposed = true }
  }, [bootId])
  const inspectAccount = async (id: string): Promise<void> => {
    if (!id || accountBusy) return
    setAccountBusy(true)
    setInspection(null)
    try {
      const response = await window.adeHost.conversations.request('account.inspect', { account_id: id })
      setInspection({ accountId: id, value: response.inspection as AccountInspection, generation: response.generation as number })
      setAccountError('')
    } catch (reason) { setAccountError(String(reason)) }
    finally { setAccountBusy(false) }
  }
  const createAccount = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!accountName.trim() || accountBusy) return
    setAccountBusy(true)
    try {
      const response = await window.adeHost.conversations.request('account.create', { provider: accountProvider, name: accountName.trim() })
      const created = response.account as Account
      await refreshAccounts()
      setAccountId(created.id)
      setInspection(null)
      setAccountName('')
      setAccountError('')
    } catch (reason) { setAccountError(String(reason)) }
    finally { setAccountBusy(false) }
  }
  const changeAccount = async (op: 'account.verify' | 'account.disable'): Promise<void> => {
    const selected = accounts.find((item) => item.id === accountId)
    if (!selected || accountBusy) return
    if (op === 'account.verify' && (!inspection || inspection.accountId !== selected.id ||
      inspection.value.state !== 'ready' || !inspection.value.identity)) return
    setAccountBusy(true)
    try {
      await window.adeHost.conversations.request(op, { account_id: selected.id,
        ...(op === 'account.verify' ? { expected_generation: inspection!.generation,
          expected_identity: inspection!.value.identity } : {}) })
      await refreshAccounts()
      setInspection(null)
      setAccountError('')
    } catch (reason) { setAccountError(String(reason)) }
    finally { setAccountBusy(false) }
  }
  const selectedAccount = accounts.find((item) => item.id === accountId)
  const accountInspection = inspection?.accountId === accountId ? inspection.value : null
  return <section className="accounts-panel" aria-label="Accounts">
    <div className="account-heading"><h2>Accounts</h2><button type="button" disabled={accountBusy}
      onClick={() => void refreshAccounts().catch((reason) => setAccountError(String(reason)))}>Refresh</button></div>
    <p className="muted">Managed accounts use separate native homes. Sign in through the provider, then inspect and verify here.</p>
    <form onSubmit={(event) => void createAccount(event)}>
      <label className="field-label" htmlFor="account-provider">New account provider</label>
      <select id="account-provider" value={accountProvider} disabled={accountBusy}
        onChange={(event) => setAccountProvider(event.target.value as 'claude' | 'codex' | 'omp')}>
        <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="omp">Oh My Pi</option>
      </select>
      <label className="field-label" htmlFor="account-name">New account name</label>
      <div className="account-create"><input id="account-name" value={accountName} maxLength={80}
        onChange={(event) => setAccountName(event.target.value)} placeholder="Account name" />
        <button type="submit" disabled={accountBusy || !accountName.trim()}>Add</button></div>
    </form>
    {accounts.length > 0 && <><label className="field-label" htmlFor="managed-account">Manage account</label>
      <select id="managed-account" value={accountId} onChange={(event) => { setAccountId(event.target.value); setInspection(null) }}>
        <option value="">Choose account</option>
        {accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.provider}</option>)}
      </select></>}
    {selectedAccount && <div className="account-details" aria-label={`Account ${selectedAccount.name}`}>
      <p><strong>{selectedAccount.name}</strong> · {selectedAccount.state}</p>
      <p>Native home: <code>{selectedAccount.native_home}</code></p>
      {selectedAccount.provider === 'claude' && <><p>Run this in a terminal to sign in through Claude Code:</p>
        <pre className="account-login-command" aria-label="Claude login command">{`env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_BASE_URL CLAUDE_CONFIG_DIR=${shellQuote(selectedAccount.native_home)} ANTHROPIC_CONFIG_DIR=${shellQuote(selectedAccount.native_home)} claude auth login`}</pre></>}
      {selectedAccount.provider === 'codex' && <><p>Run this in a terminal to sign in through Codex:</p>
        <pre className="account-login-command" aria-label="Codex login command">{`env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" CODEX_HOME=${shellQuote(selectedAccount.native_home)} codex login`}</pre></>}
      {selectedAccount.provider === 'omp' && <><p>Run this in a terminal and choose one OAuth provider. Keep only one credential in this account home:</p>
        <pre className="account-login-command" aria-label="Oh My Pi login command">{`(cd ${shellQuote(selectedAccount.native_home)} && env -i HOME="$PWD" PATH="$PATH" TERM="$TERM" PI_CODING_AGENT_DIR="$PWD" sh -c 'test "$(omp --version)" = "omp/18.3.0" || { echo "ADE needs Oh My Pi 18.3.0" >&2; exit 1; }; exec omp login')`}</pre></>}
      {selectedAccount.claude_identity && <p>Bound identity: {selectedAccount.claude_identity.email} · organization {selectedAccount.claude_identity.org_id} · {selectedAccount.claude_identity.auth_method} / {selectedAccount.claude_identity.api_provider}</p>}
      {selectedAccount.codex_identity && <p>Bound identity: {selectedAccount.codex_identity.email} · ChatGPT account {selectedAccount.codex_identity.chatgpt_account_id}</p>}
      {selectedAccount.omp_identity && <p>Bound identity: {accountIdentityLabel(selectedAccount.omp_identity)}</p>}
      {accountInspection && <div role="status"><p>Last inspection: {accountInspection.state.replaceAll('_', ' ')}</p>
        <p>{accountInspection.reason}</p>
        {accountInspection.identity && <p>Native identity: {accountIdentityLabel(accountInspection.identity)}</p>}</div>}
      {!['claude', 'codex', 'omp'].includes(selectedAccount.provider) &&
        <p>Inspection and verification are unavailable for this provider.</p>}
      <div className="account-actions">
        <button type="button" disabled={accountBusy || !['claude', 'codex', 'omp'].includes(selectedAccount.provider)} onClick={() => void inspectAccount(selectedAccount.id)}>Inspect</button>
        <button type="button" disabled={accountBusy || !['claude', 'codex', 'omp'].includes(selectedAccount.provider) ||
          accountInspection?.state !== 'ready' || !accountInspection.identity}
          onClick={() => void changeAccount('account.verify')}>Verify</button>
        <button type="button" disabled={accountBusy || selectedAccount.state === 'disabled'}
          onClick={() => void changeAccount('account.disable')}>Disable in ADE</button>
      </div>
      {selectedAccount.state === 'disabled' && <p>Disabled in ADE. Native provider sign-in is unchanged.</p>}
    </div>}
    {accountError && <p role="alert" className="inline-error">{accountError}</p>}
  </section>
}
