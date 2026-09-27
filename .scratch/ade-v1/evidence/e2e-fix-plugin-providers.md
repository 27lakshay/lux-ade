# E2E fix: plugin providers

Headless spec: `e2e/protocol/adapters/plugin-provider-registry.spec.ts`.
All three tests failed on the code before the fix and pass after it.
`adapters/plugin-provider*`, `orchestration` and `providers` together pass (48 tests).
`pnpm check:static` passes.

## 1. plugin.uninstall deleted provider leases before admission

- **Defect.** `Sessions::uninstall_plugin` called `Plugins::release_provider`
  for every idle conversation before `plugin.uninstall` was admitted. A later
  refusal (operation-ID conflict, draining host, bad request) left those
  conversations unpinned and their old generation retired. After re-enabling,
  they resumed on the newer worker version.
- **Fix.** `uninstall_plugin` no longer releases anything. It passes the idle
  conversations to `Plugins::uninstall_releasing`. `commit_uninstall` checks
  every refusal first. The pure `plugins::dev::uninstall_plan` makes the
  decision: leases held by these idle sessions do not block, and any other
  lease or a draining host refuses. The leases are deleted inside the
  uninstall's own transaction, next to its receipt. A replayed or refused
  uninstall releases nothing.
- **Tests.**
  - Pure: `plugins::dev::tests::a_refused_uninstall_releases_no_idle_lease`.
  - E2E: `04-S11: a refused uninstall releases no lease, so an idle
    Conversation resumes on its old version`. It reuses an operation ID so the
    uninstall is refused. Generation 1 stays `leased`, and the conversation
    resumes on v1 after re-enabling. A later admitted uninstall still succeeds.

## 2. Delegated children and capability queries used the static catalogue

- **Defect.** `orchestration.delegate` and `orchestration.group.start` created
  children through `create_with_account`, which validates against the static
  catalogue. An `adapter:` or `plugin:` child was refused. `provider.capabilities`
  and `provider.readiness` answered "Unknown provider" for registered providers.
- **Fix.**
  - Delegation and group start resolve `registered_descriptor` outside the
    store lock, as `conversation.create` does. `insert_child` uses
    `create_registered` for such a provider. The new child is pinned with
    `pin_new`, which takes the plugin lease.
  - The pure `policy::registered_account` refuses a managed or inherited
    account for a registered child.
  - The pure `capabilities::core::registered_record` builds a sealed
    capability record from the registry descriptor. It claims only what the
    descriptor states, leaves the rest `unknown`, and marks managed accounts
    `unsupported`.
  - `provider.capabilities` lists these records after the bundled ones.
  - `provider.readiness` reports `installed_unchecked` with a passed
    `registration` check. It refuses an `account_id`.
  - A disabled plugin or an adapter that is not ready is refused with the
    registry's message.
  - The wire contract is unchanged.
- **Tests.**
  - Pure: `sessions::orchestration::policy::tests::a_registered_child_carries_no_account`
    and `capabilities::core::tests::a_registered_provider_record_claims_only_its_declaration`.
  - E2E: `F023: a delegated child and a parallel run can use a plugin provider`
    and `F023: provider.capabilities and provider.readiness describe a plugin
    provider from its registration`.

## Not changed

- `Plugins::release_provider` has no caller now. It is kept as the API for
  ending one session's lease.
- `preset.save` still validates against bundled records only. The defect did
  not list it.
