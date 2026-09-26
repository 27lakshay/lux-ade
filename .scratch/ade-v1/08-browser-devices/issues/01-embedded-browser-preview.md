# Embedded browser preview in a profile

Status: implemented partial slice; post-restart cookie persistence remains open
Type: implementation ticket
Requirements: F091, F092 (daily-use slice), 08-S11, 08-S12
Depends on: desktop profile selection, managed service preview URL, Electron main-process ownership

Outcome: In the running Electron app, open a local development URL in a tab that belongs to the selected ADE profile. Navigate and reopen that tab after an app restart. Page content, redirects and popups never receive the ADE application bridge. Closing the tab makes its identity unavailable to callers rather than silently selecting another tab. This slice does not complete F091 or F092.

## Boundary and implementation

1. Electron main owns each tab and its stable ID. Create untrusted page contents with `WebContentsView`, a persistent session path derived from the ADE profile identity, no preload, Node integration disabled, context isolation and sandbox enabled. Keep the trusted app bridge only in the ADE renderer. Do not use the deprecated `BrowserView` or enable the `<webview>` tag.
2. Store tab metadata (ID, profile ID, last requested URL, title and last observed URL) in the selected profile's state. Restore metadata explicitly after restart. A failed load is visible and preserves the tab identity; never replace a closed target with the newly focused tab.
3. Admit only `http:` and `https:` URLs in this first slice. Validate direct requests and navigation outcomes, including redirects, frame navigation and popups. Open a popup as an explicitly identified untrusted tab in the same partition or deny it visibly. No popup receives an ADE preload or privileged window options.
4. Present a tab list, address control, loading/error state and a preview pane. A managed service's preview URL may be copied/opened here; the browser must still allow any user-entered local or remote HTTP(S) URL.
5. Scope every tab operation to the current profile and exact tab ID. On profile switch, hide and detach the old profile's view and show only the selected profile's tab. Closing a tab destroys its contents and makes later operations on its ID return `unavailable`.

Electron's current [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [session partitions](https://www.electronjs.org/docs/latest/api/session), [navigation events](https://www.electronjs.org/docs/latest/api/web-contents), and [popup handler](https://www.electronjs.org/docs/latest/api/window-open) document these APIs. Verify the installed Electron version and its types before implementation.

## E2E acceptance for this slice

- Start a real ADE desktop with two isolated ADE profiles and a local HTTP fixture. Open one tab in each profile, set a distinct cookie, switch profiles and restart. Assert tab metadata returns under its own profile and cookies stay separate.
- Serve a page that checks for ADE's bridge on first load, after same-tab navigation, after an HTTP redirect, in a child frame and in a popup. Assert the bridge is absent in every page. A popup must be denied visibly or appear as a separately identified untrusted tab.
- Open a managed local service URL, navigate away and back, then stop the service. Assert the tab reports the load failure while its identity and address remain visible.
- Close a tab, focus another and call the public operation with the closed ID. Assert `unavailable` and no change to the focused tab. Repeat across a profile switch.
- Use only running-app/public-protocol E2E tests with real ADE processes. No unit or isolated integration tests.

## Remaining requirement work

This slice does not deliver browser import, automation, diagnostics, recording or unattended runtime-owned sessions. Full F091/F092 still need their broader spec acceptance and evidence recorded in the requirements register.

## Delivery evidence and remaining acceptance, 26 September 2026

The Electron preview now owns stable tab IDs, metadata in each managed ADE
profile home, an isolated browser session per profile, exact-ID operations,
HTTP(S) navigation, denied popups and denied page permissions. A fixed-socket
development run scopes its browser storage to the daemon socket identity.
The browser has no ADE preload. A selected managed HTTP service can be opened,
navigated away from and back to, then reports a load failure after the service
stops without replacing its tab ID.

`pnpm exec playwright test e2e/specs/desktop-browser.spec.ts
e2e/specs/desktop-services.spec.ts e2e/specs/desktop-review-feedback.spec.ts`
on macOS arm64 exercises these paths through real ADE processes. The browser
fixture checks bridge absence in the main page, redirect destination and child
frame, popup denial, geolocation-permission denial, two-profile cookie
isolation while running, metadata across normal restart, fixed-socket
isolation, and closed-ID rejection. This is partial F091/F092 and 08-S11/08-S12
evidence; it does not close those requirements.

**Open failure:** a persistent `Max-Age` cookie in the inactive Work browser
profile is present through `session.cookies.get` before quit but absent after
restart in this unsigned Electron 44.4.5 development build. The test fixture
observed no `Cookies` database under its isolated temporary profile tree after
`cookies.flushStore()`. The post-restart cookie assertion failed repeatedly.
Electron's [cookie API](https://www.electronjs.org/docs/latest/api/cookies)
documents the flush operation, while its [code-signing guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing)
warns that cookie encryption can behave inconsistently without a stable code
signature. This may be a local signing/runtime issue; it is not evidence that
packaged signed builds work. Verify on a consistently signed app or implement
and E2E-test a secure profile cookie restore before closing F092. The passing
browser E2E covers live cookie isolation and restart metadata, not cookie
persistence.

An independent code review also identified switch-time view reattachment,
pending tab-state writes on quit, download permission, aborted-load state,
malformed saved entries, preview positioning and history side effects. The
implementation now closes those paths. The running-app E2E blocks an attachment
download without a save dialog and restores a valid tab when saved metadata
also contains a malformed entry.
