---
name: drive-ade-app
description: See, drive, debug and profile the running ADE desktop app (Electron) in development. Use when checking a UI change in the real app, reading renderer or main-process errors, taking screenshots, clicking through a flow, inspecting app state, or recording a performance trace.
---

# Drive the ADE desktop app

Full reference: [docs/agents/desktop-debugging.md](../../../docs/agents/desktop-debugging.md).

1. **Is it running?** `curl -s http://127.0.0.1:9334/state`. If nothing answers, start it with
   `wt dev pnpm dev` from the repo root and poll until `http://127.0.0.1:9333/json/version` answers.
   After editing `apps/desktop/src/main` or `src/preload`, restart it; renderer edits hot-reload.
2. **Read before acting.** `.dev/logs/main.log` has the main process and the window console.
   `/state` has windows, web contents, the daemon connection and profiles.
3. **Drive the window with agent-browser**, never auto-connected to the user's browser:

   ```sh
   export AGENT_BROWSER_AUTO_CONNECT=0
   agent-browser --session ade-app --cdp 9333 snapshot -i      # refs like @e14
   agent-browser --session ade-app --cdp 9333 click @e14
   agent-browser --session ade-app --cdp 9333 screenshot /tmp/ade.png
   agent-browser --session ade-app --cdp 9333 errors
   ```

   Snapshot again after every action; refs go stale. Look at screenshots before claiming a visual
   result.
4. **Profile or audit** with the `ade-app-devtools` MCP server (chrome-devtools-mcp):
   `list_pages`, then `performance_start_trace` / `performance_stop_trace` or `take_snapshot` with
   that `pageId`.
5. **Attach only to the app window** (URL `http://localhost:5173/`), not to embedded browser tabs.

Report what you saw, with the screenshot path or log lines, and say what you could not check.
