# resource-claims

Status: returned
Type: slice evidence
Branch: claude/wf_12f3c438-218-6
Worker: Phase 2 round E, slice resource-claims
Requirements: R007, F086, F087, F099, F100 (advanced, not accepted)

## Outcome

HostResources now claims service ports and devices as well as checkouts, in
the same host-wide registry and under the same quarantine rules. No
requirement is fully accepted: acceptance needs E2E runs with two real
profiles.

- **Service ports.** `service.start` reserves every assigned TCP port
  host-wide before launch (phase `reserved`). It commits `dispatched` before
  handing the launch to the runtime; a failed commit stops the launch.
  - Another profile's claim on the port refuses the start with
    `host_resource_conflict`.
  - A launch error leaves the claims quarantined as `outcome_unknown`.
  - `listener.list`, `service.inspect` and the other callers of
    `list_listeners` bind a launched claim to its listener (phase `bound`,
    `listener_pid`). They bind only when every listener on the port belongs to
    the run's own process tree.
  - `service.stop` settles the claims only after it verified the run exited.
    It then observes the host's TCP listeners. A claim is released only when
    no listener is left on its port. A remaining listener, or an observation
    that failed, quarantines the claim instead.
  - The profile's own reconciliation retires a stale claim. A new start of
    the same service identity supersedes its quarantined claim when the
    catalogue shows no run and the bind probe found the port free.
- **Devices.** `device.boot`, `device.app.install` and `device.app.launch`
  each take an exclusive host-wide claim on the canonical device ID for the
  duration of the effect. The claim settles by the operation's receipt:
  - no receipt, `accepted` or `settled`: released;
  - `dispatched`, `acknowledged` or `unknown`: quarantined.
  - A replay with the same operation ID supersedes its own quarantined claim,
    because receipt reconciliation observes the device.
- **Device holds.** `resources.device.hold` gives one run of a profile an
  exclusive hold on a simulator or emulator. The hold refuses other profiles'
  device effects and holds, and other runs' holds, while admitting its own
  profile's effects. `resources.device.release` ends it. Displays are not
  claimable.
- **Quarantine.** Port and device claims use the existing owner-loss rule. A
  port reservation that never dispatched is released. A dispatched or bound
  port claim is quarantined as `outcome_unknown`. A device claim starts
  `active`, so owner loss quarantines it as `owner_lost_during_use`. A
  missing PID or a released lock never clears one.
  `resources.claim.resolve` releases a quarantined port claim with
  `confirm_path: "tcp:<port>"`, or a device claim with the device ID.
- **Registry compatibility.** Port and device claims share the `claims`
  table and keep format `1`. They carry `resource`, `holder` and
  `listener_pid` fields and an empty identity chain. An older daemon ignores
  the new fields, reads the claims as keys that nest with nothing, and still
  sweeps, lists and resolves them.

Pure decisions, in `crates/ade-daemon/src/host_resources.rs`:

- `port_conflicts`, `device_conflicts` and `claim_conflicts`;
- `supersedes`;
- `settle_effect` and `settle_port_after_stop`;
- `settled_by_holder`, `initial_phase`, `device_claim_id` and `valid_holder`.

## Operation tiers

- `resources.inspect` (query): new optional `resource` filter (`checkout`,
  `port`, `device`). Claims gain `resource`, `port`, `device_id`, `holder` and
  `listener_pid`. The change is additive; `resource` defaults to `checkout`.
- `resources.device.hold` (idempotent command): new. A repeated hold for the
  same holder returns the same claim.
- `resources.device.release` (idempotent command): new. It converges when the
  hold is already gone, and refuses a quarantined hold.
- `resources.claim.resolve` (effect command): unchanged wire. It now also
  resolves port and device claims.
- `service.start` and `device.boot`, `device.app.install` and
  `device.app.launch` (effect commands): unchanged wire. They can now fail
  with `host_resource_conflict`, or with `host_resources_unavailable` while
  the registry is blocked (fail closed).
- `service.stop` (effect command): unchanged wire and result.
- `listener.list` and `service.inspect` (queries): unchanged wire. They
  record the listener binding in the registry as a side effect.
- CLI: new `apps/cli/src/commands/resources.ts` with `resources inspect`,
  `resolve`, `accept` and `device hold|release`.

## Checks

- `pnpm check:static`: pass.
- In-process tests added, in `crates/ade-daemon/src/host_resources.rs`
  (`#[cfg(test)]`, 9 new pure-core tests):
  - port exclusivity across owners, modes and quarantine;
  - device exclusivity across profiles and runs;
  - supersession;
  - effect settlement by receipt and port settlement after stop;
  - holder scoping and initial phases;
  - canonical device IDs;
  - compatibility with claims written by older daemons.
- In `crates/ade-core/src/contract/resources.rs`: the schema round trip now
  covers the two new requests and a port claim.

**Verified only statically:** the `start_service`, `stop_service` and
`list_listeners` wiring; the `HostClaim` guard in the three device effects;
and the new `resources.*` handlers and CLI command.

**Needs E2E later:**

- F087 and R007: two profiles start services with the same assigned port;
  the second is refused while the first is launching or running, and admitted
  after a verified stop.
- F086: a service that leaves an escaped listener keeps its port claim
  quarantined after stop.
- R007: daemon restart with a running service; the claim is quarantined and
  the next start or stop of the same service reconciles it.
- F099 and F100: boot a simulator from one profile while another profile
  holds it; a boot that passes its deadline keeps the device quarantined
  until it is replayed.
- The CLI `resources` commands.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 60 | 5 | 10 | 0 |

## References

- `.scratch/parallel-build/research/08-reference-map.md`: no reference repo
  covers cross-profile port or device claims. The map's port entries, t3code
  `PortScanner` and Ghostex `portless`, are advisory scanning and proxy
  routing. Nothing was copied.
- In-repo: `crates/ade-daemon/src/listeners.rs` (tree attribution and
  `observe`), `crates/ade-daemon/src/devices.rs` (`Target` canonical IDs),
  `crates/ade-daemon/src/receipts.rs` (receipt states), and the
  host-resources slice's owner-loss rules.

## Open

- **Coordinator, shared files:** none. `sessions.rs` changed one match arm
  to route every `resources.*` operation. `worktrees.rs` gained a
  `host_resources()` accessor and two arms in `resources_command`.
- **Not done:**
  - New port allocation (`services.rs` `available`) does not yet skip ports
    another profile has claimed. A clash is refused at start, not avoided at
    allocation.
  - `resources.registry.accept` re-claims only checkout leases. Port and
    device claims of running work stay in the old registry.
  - Device effects do not carry a run identity, so another run of the same
    profile can operate on a device this profile's run holds.
  - A replay of a settled device operation is refused while another profile
    holds the device, even though it only returns the stored result.
  - The in-process device `Claim` in `sessions/devices.rs` keys on the raw
    device ID, so case variants of one UDID are not serialized in process.
    The host claim uses the canonical ID.
  - `lsof` sees only listeners of processes visible to this user, so a
    listener of another user's process does not keep a port quarantined
    after stop.
  - An Android emulator reached as `android-serial:emulator-5554` and as
    `android-avd:<name>` gets two claim keys; `device.list` reports the AVD
    ID for a running emulator whose AVD is known.
  - No host admission budgets.
