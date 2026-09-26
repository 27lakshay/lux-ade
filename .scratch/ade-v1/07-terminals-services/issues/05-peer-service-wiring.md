# Peer-service wiring (F089)

Status: direct local peer slice accepted; full F089 remains open
Type: implementation ticket

## Contract

A workspace service recipe may declare `peers`, mapping an environment variable
to another service name and one of that service's allocated port variables.
Peer variables cannot collide with the recipe's own environment or ports.
Configuration rejects dependency cycles. On launch, ADE resolves each peer to
an explicit host-local HTTP URL only when the target's current runtime transfer
identity, process and IPv4 TCP listener match. A stopped, missing, changed or
contested peer fails the dependent launch rather than silently substituting an
unrelated process. The selected URL is recorded with the dependent run and
injected into its environment.

`service.start` and `service.inspect` expose the run's effective peer URLs without
exposing other environment values. Inspection reports current peer availability
separately, so stopping or remapping a peer cannot rewrite the URL that the
dependent process actually received. A running dependent service is not stopped
when its peer stops; its own application decides how to react to
an unavailable URL.

## Acceptance and limits

- Through a real daemon and Electron, configure two managed services. Starting
  the dependent before its peer must fail. After the peer starts, the dependent
  must receive the declared URL, use it, and display the effective URL.
- Stop the peer first. The dependent's effective URL must stay unchanged while
  current availability becomes unavailable. Starting it again must fail until
  the peer is running. Reject a configured dependency cycle.
- Recheck after daemon/runtime restart, process descendants and IPv6-only
  listeners, and verify cross-profile host claims before marking F089 complete.
  The current listener evidence accepts a directly owned IPv4 process only.
- F088's stable proxy URL remains separate work. Direct peer URLs in this slice
  can stop serving when the target process stops or its assigned port changes.

Evidence: `e2e/specs/service-peer-wiring.spec.ts` exercises the public protocol,
real service processes and hidden Electron. Record the integrated revision and
check result in `progress.md` after review and commit.
