# Third-party notices

ADE includes code adapted from the projects below. Each entry names the source
repository and snapshot, its licence, and the ADE files that contain adapted code.
Those files carry a `Portions adapted from` header.

The licence texts that apply are MIT and Apache-2.0. An entry under Apache-2.0
also records that the adapted files were modified.

<!-- Add one section per source repository, in this form:

## <repo> (<licence>)

Source: <upstream URL> at <snapshot commit>
Copyright: <holder line from the source LICENSE>

| ADE file | Source path | Changes |
|---|---|---|

-->

## Orca (MIT)

Source: https://github.com/stablyai/orca at `b7a4fee7`
Copyright: Copyright (c) 2026 Lovecast Inc.

| ADE file | Source path | Changes |
|---|---|---|
| `crates/ade-daemon/src/observability/redact.rs` | `src/main/observability/redactor.ts` | Ported to Rust: key-family blocklist, labeled key-value rule, provider-key fingerprints with tagged replacements, URL userinfo stripping |
