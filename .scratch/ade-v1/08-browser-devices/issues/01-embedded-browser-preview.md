# Embedded browser preview in a profile

Status: ready-for-agent
Type: implementation ticket
Requirements: F091, F092 (daily-use slice), 08-S11, 08-S12
Depends on: desktop profile selection, managed service preview URL, Electron main-process ownership

Outcome: In the running Electron app, open a local development URL in a tab that belongs to the selected ADE profile. Navigate and reopen that tab after an app restart. Page content, redirects and popups never receive the ADE application bridge. Closing the tab makes its identity unavailable to callers rather than silently selecting another tab. This slice does not complete F091 or F092.

## Boundary and implementation

1. Electron main owns each tab and its stable ID. Create untrusted page contents with `WebContentsView`, a `persist:` session partition derived from the ADE profile identity, no preload, Node integration disabled, context isolation and sandbox enabled. Keep the trusted app bridge only in the ADE renderer. Do not use the deprecated `BrowserView` or enable the `<webview>` tag.
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
