# 11 — Electron's idle memory floor

Status: open
Type: task
Label: wayfinder:task
Assignee: none
Blocked by: none

Found by ticket 08's benchmark ([evidence](../../ade-v1/evidence/daemon-authority.md)). A
production build of the desktop uses 571 MB with nothing loaded; the last recorded floor was
about 216 MB, measured another way. Load adds about 158 MB, which is fine.

## Build

1. Measure the floor on the commit that recorded 216 MB and on `main`, with the same script, to
   learn whether it rose or was never comparable.
2. Find what Electron main (199 MB) and the Node utility process (104 MB) hold. Main bundles the
   generated contract validators (5.8 MB of source); check whether main needs them, or needs
   them compiled lazily.
3. Fix what is found, or record the floor as the new baseline with its reason.

## Acceptance

- The floor is explained, and either reduced or recorded as the baseline in the map.
