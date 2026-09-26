# Browser session ownership, backup and retention

Status: ownership and interrupted-migration slice implemented; backup and retention remain open
Type: implementation ticket
Requirements: F092, R014, R015 (partial)
Depends on: 01-embedded-browser-preview, profile lifecycle, managed backup and retention contracts

Outcome: ADE knows which profile owns each Electron browser session, tab metadata file and retained legacy copy. A profile move, backup, restore or deletion never silently selects another profile's session or removes referenced browser data.

The Electron session lives under `userData/browser-sessions/<hash(profile ID)>`, while tab metadata and any retained legacy session copy live in the profile home. Fresh sessions now publish a durable profile-ID owner manifest before the session opens. Legacy migrations copy into a claimed stage, fsync the copy and owner, then rename into place. On restart ADE removes only empty or claimed stages whose creating process is gone; it leaves the original legacy source intact. A destination with an owner for another profile refuses selection. An ownerless old destination also refuses automatic selection: the app names the affected profile, warns that ADE cannot prove the session's original owner, and offers an explicit, confirmed adoption action. Cancelling leaves the data untouched. A moved runtime home currently cannot reconnect because its launcher binds the old absolute path; selection fails before browser writes.

No backup or retention operation yet coordinates the two browser roots. Two Electron processes can still write the same profile metadata without a cross-process lease, and PID reuse can conservatively leave a stale stage needing review. This ticket does not claim complete R014/R015 or full F092 acceptance.

E2E acceptance through real ADE processes:

1. Migrate a legacy session and kill the test-owned Electron process at the copy, marker and rename boundaries. On relaunch, recover the original cookies without selecting an ambiguous destination, deleting the legacy source or leaving unbounded temporary copies.
2. Seed a destination whose ownership disagrees with the selected profile; selection refuses it, and the previous profile's client, browser and saved default remain usable. Move a profile home without changing its identity and verify tabs/cookies bind to the intended storage or fail explicitly before writes.
3. Back up during active tab/session writes, then restore into a disposable profile and verify tab identity plus supported cookies through the running app. Declare which native/private browser data is excluded; reject unsupported restore schemas before mutation.
4. Run retention or profile deletion while a browser view or backup lease is active. Keep live, referenced and in-flight session data; remove only verified unreferenced data after all owners release it. Two app processes targeting one profile must serialize writes or refuse the second writer with an actionable result.

Do not clean the retained legacy source merely because a migration marker exists. A restore-tested backup/retention owner must first account for both storage roots and active session leases. Preserve the F092 isolation and cookie-restart E2E while implementing this lifecycle.

Ownership-slice evidence at implementation revision `487b907` on macOS arm64: `pnpm check` passed type checking, Fallow, backend/frontend builds and 84/84 source E2Es. `pnpm package:mac` and `pnpm test:e2e:package` passed 6/6 packaged E2Es. Running `ADE_E2E_BROWSER_APP="$PWD/dist/electron/mac-arm64/Lux ADE.app" pnpm exec playwright test e2e/specs/desktop-browser.spec.ts` passed 2/2 in the packaged app. `e2e/specs/browser-migration-recovery.spec.ts` uses running Electron and ADE daemons. It kills Electron after fresh stage creation and owner fsync, and during legacy stage, copy, marker and rename; relaunch checks the original tab/cookie, source retention and stage cleanup. It also covers mismatched and ownerless destination refusal, explicit adoption of a pre-manifest session, and moved-home refusal before browser writes. `desktop-browser.spec.ts` retains cookie isolation, ordinary migration and restart coverage. These tests use local HTTP fixtures, not hosted account verification. The full ticket remains open for acceptance items 3 and 4.
