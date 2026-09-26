# Browser session ownership, backup and retention

Status: ready-for-agent
Type: implementation ticket
Requirements: F092, R014, R015 (partial)
Depends on: 01-embedded-browser-preview, profile lifecycle, managed backup and retention contracts

Outcome: ADE knows which profile owns each Electron browser session, tab metadata file and retained legacy copy. A profile move, backup, restore or deletion never silently selects another profile's session or removes referenced browser data.

The current Electron session lives under `userData/browser-sessions/<hash(profile ID)>`, while tab metadata and any legacy session copy live in the profile home. A session copied during migration has a marker, but a fresh session has no ownership manifest. A process killed during migration can leave an orphan `.migrating-*` directory. No existing backup or retention operation coordinates these locations. An independent audit also found that two Electron processes can write the same profile metadata without a cross-process lease. This ticket does not assume a complete R014/R015 implementation already exists.

E2E acceptance through real ADE processes:

1. Migrate a legacy session and kill the test-owned Electron process at the copy, marker and rename boundaries. On relaunch, recover the original cookies without selecting an ambiguous destination, deleting the legacy source or leaving unbounded temporary copies.
2. Seed a destination whose ownership disagrees with the selected profile; selection refuses it, and the previous profile's client, browser and saved default remain usable. Move a profile home without changing its identity and verify tabs/cookies bind to the intended storage or fail explicitly before writes.
3. Back up during active tab/session writes, then restore into a disposable profile and verify tab identity plus supported cookies through the running app. Declare which native/private browser data is excluded; reject unsupported restore schemas before mutation.
4. Run retention or profile deletion while a browser view or backup lease is active. Keep live, referenced and in-flight session data; remove only verified unreferenced data after all owners release it. Two app processes targeting one profile must serialize writes or refuse the second writer with an actionable result.

Do not clean the retained legacy source merely because a migration marker exists. A restore-tested backup/retention owner must first account for both storage roots and active session leases. Preserve the F092 isolation and cookie-restart E2E while implementing this lifecycle.
