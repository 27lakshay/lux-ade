# Run the local demo

Historical GPUI demo. `scripts/demo.py` launches the removed `ade-client` executable, so this
page is retained for prototype evidence and does not describe the current Electron app. For
current credential-free checks, use the scratch profiles and provider mocks in
[protocol E2E](../e2e/protocol/README.md) or [desktop E2E](../e2e/desktop/README.md).

The demo uses the real lux-ade daemon, runtime, client, and Codex protocol adapter with a deterministic local provider fixture. It needs no model account and makes no model calls.

Build the workspace first, then run:

```sh
python3 scripts/demo.py
```

The release profile is the default. For a debug build or a separate Cargo target directory:

```sh
python3 scripts/demo.py --profile debug --target-dir /absolute/path/to/target
```

`CARGO_TARGET_DIR` is also honored. The script uses existing binaries; it does not download dependencies or build them.

The window opens a conversation containing Markdown, a code block, a structured tool result, and a pending approval. A second, empty pane offers Conversation, Terminal, and Browser. Browser and terminal content remain unopened until selected. The tool result intentionally includes a fixture failure so error presentation can be inspected. Approving the fixture request does not execute its displayed command.

Use the normal GUI to answer the approval and send follow-up messages. All four provider launchers point to local mocks. Close the demo window or press Ctrl-C in the launching terminal to stop it. The script creates a temporary data directory and socket, then stops only its own child processes and the runtime instance identified by the daemon handshake. It does not reuse your normal lux-ade profile.

## Headless workflow check

```sh
python3 scripts/demo.py --no-client
```

This checks Markdown/code output and a tool result, declines an approval through the daemon, sends a follow-up, and exits after cleanup. A successful run prints `PASS`. It verifies the provider protocol and persistence path; it does not verify native rendering or pointer interaction.

For the provider-free component preview instead of a complete daemon workflow, launch the client with `ADE_UI_SHOWCASE=1`.

To verify a packaged application, including its installed native resources:

```sh
python3 scripts/demo.py --app '/path/to/lux-ade.app'
```

The fixture scripts still come from this checkout. The client, daemon, runtime,
terminal attachment binary, and installed resources come from the chosen app.
This checks relocation; it does not prove provider runtime prerequisites are
bundled or that the app is signed.
