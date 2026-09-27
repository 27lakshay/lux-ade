//! Terminal viewport ownership and stream-incarnation fencing (F083).
//!
//! Portions adapted from Paseo `packages/server/src/terminal/terminal-size-ownership.ts`
//! (Apache-2.0): the claim/update resize intents. Modified: ported to Rust,
//! extended with input-driven transfer, ranked hand-off on detach and
//! incarnation fencing.
//!
//! One attachment owns the viewport and controls the PTY size; every other
//! attachment observes. A `claim` resize or input from a registered attachment
//! takes ownership. An `update` resize from a non-owner only records that
//! attachment's geometry. When the owner detaches, ownership passes to the
//! attachment with the most recent claim, then the most recent registration.
//!
//! Every terminal host run has one stream incarnation (its `run_id`). A request
//! that names an incarnation other than the current one is stale and changes
//! nothing. A request that names none is accepted, as single-client callers
//! always were.
use serde_json::Value;
use std::collections::HashMap;

/// One attachment's terminal geometry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Viewport {
    pub cols: u16,
    pub rows: u16,
    pub width: u16,
    pub height: u16,
}

/// How a resize treats ownership.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    /// Take ownership and apply this geometry.
    Claim,
    /// Apply only when this attachment already owns the viewport, or when
    /// nobody does.
    Update,
}

impl Intent {
    /// Reads the wire `claim` flag; absent means `update`.
    pub fn from_request(request: &Value) -> Self {
        if request["claim"].as_bool().unwrap_or(false) {
            Self::Claim
        } else {
            Self::Update
        }
    }
}

/// What the terminal host must do after an ownership decision.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Decision {
    /// Geometry to apply to the PTY. Applying an unchanged size is a no-op.
    pub apply: Option<Viewport>,
    /// Set when the owner changed: `(previous, next)`.
    pub transfer: Option<(Option<u64>, Option<u64>)>,
}

#[derive(Clone, Copy, Debug)]
struct Claimant {
    viewport: Viewport,
    claim: u64,
    registered: u64,
}

/// Viewport ownership for one terminal incarnation.
#[derive(Debug, Default)]
pub struct Viewports {
    owner: Option<u64>,
    claimants: HashMap<u64, Claimant>,
    next_rank: u64,
}

impl Viewports {
    pub fn owner(&self) -> Option<u64> {
        self.owner
    }

    fn rank(&mut self) -> u64 {
        self.next_rank += 1;
        self.next_rank
    }

    fn set_owner(&mut self, owner: Option<u64>) -> Option<(Option<u64>, Option<u64>)> {
        let previous = std::mem::replace(&mut self.owner, owner);
        (previous != owner).then_some((previous, owner))
    }

    /// Records an attachment's geometry and decides whether it resizes the PTY.
    pub fn resize(&mut self, attachment: u64, viewport: Viewport, intent: Intent) -> Decision {
        let claim = intent == Intent::Claim || self.owner.is_none();
        let transfer = if claim {
            self.rank();
            self.set_owner(Some(attachment))
        } else {
            None
        };
        let rank = if claim {
            self.next_rank
        } else {
            self.claimants.get(&attachment).map_or(0, |c| c.claim)
        };
        let registered = match self.claimants.get(&attachment) {
            Some(existing) => existing.registered,
            None => self.rank(),
        };
        self.claimants.insert(
            attachment,
            Claimant {
                viewport,
                claim: rank,
                registered,
            },
        );
        Decision {
            apply: (self.owner == Some(attachment)).then_some(viewport),
            transfer,
        }
    }

    /// Input from an attachment that has reported its geometry makes it the
    /// owner, so the PTY follows the attachment the user is typing into.
    /// Input from one that never reported geometry changes nothing.
    pub fn input(&mut self, attachment: u64) -> Decision {
        if !self.claimants.contains_key(&attachment) {
            return Decision::default();
        }
        let rank = self.rank();
        let claimant = self.claimants.get_mut(&attachment).expect("checked above");
        claimant.claim = rank;
        let viewport = claimant.viewport;
        Decision {
            apply: Some(viewport),
            transfer: self.set_owner(Some(attachment)),
        }
    }

    /// Forgets an attachment. When it owned the viewport, ownership passes to
    /// the most recent claimant and its geometry is applied.
    pub fn detach(&mut self, attachment: u64) -> Decision {
        self.claimants.remove(&attachment);
        if self.owner != Some(attachment) {
            return Decision::default();
        }
        let next = self
            .claimants
            .iter()
            .max_by_key(|(_, c)| (c.claim, c.registered))
            .map(|(id, c)| (*id, c.viewport));
        Decision {
            apply: next.map(|(_, viewport)| viewport),
            transfer: self.set_owner(next.map(|(id, _)| id)),
        }
    }
}

/// Why a terminal request was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The request names a different stream incarnation, or names it badly.
    Stale,
    /// The incarnation's process has exited; input and resize would reach nothing.
    Exited,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Stale => "stale_incarnation",
            Self::Exited => "incarnation_exited",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::Stale => {
                "This terminal attachment belongs to an earlier incarnation; reattach to continue"
            }
            Self::Exited => "This terminal incarnation has exited; restart it to send input",
        }
    }
}

/// Checks the incarnation a request names against the current one.
/// `run_id` absent or `null` is accepted for callers that predate fencing;
/// any other non-matching value, including a non-string, is stale.
pub fn fence(current: &str, request: &Value) -> Result<(), Refusal> {
    match request.get("run_id") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(named)) if named == current => Ok(()),
        Some(_) => Err(Refusal::Stale),
    }
}

/// Fences a request that would reach the process: input or resize.
pub fn fence_effect(current: &str, running: bool, request: &Value) -> Result<(), Refusal> {
    fence(current, request)?;
    if running {
        Ok(())
    } else {
        Err(Refusal::Exited)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn size(cols: u16, rows: u16) -> Viewport {
        Viewport {
            cols,
            rows,
            width: 0,
            height: 0,
        }
    }

    #[test]
    fn a_single_attachment_owns_and_resizes_without_claiming() {
        let mut viewports = Viewports::default();
        let first = viewports.resize(1, size(80, 24), Intent::Update);
        assert_eq!(first.apply, Some(size(80, 24)));
        assert_eq!(first.transfer, Some((None, Some(1))));
        let second = viewports.resize(1, size(120, 40), Intent::Update);
        assert_eq!(second.apply, Some(size(120, 40)));
        assert_eq!(second.transfer, None);
        assert_eq!(viewports.input(1).transfer, None);
    }

    #[test]
    fn an_observer_update_never_resizes_the_owner() {
        let mut viewports = Viewports::default();
        viewports.resize(1, size(80, 24), Intent::Update);
        let observer = viewports.resize(2, size(200, 60), Intent::Update);
        assert_eq!(observer, Decision::default());
        assert_eq!(viewports.owner(), Some(1));
    }

    #[test]
    fn a_claim_takes_ownership_and_the_old_owner_observes() {
        let mut viewports = Viewports::default();
        viewports.resize(1, size(80, 24), Intent::Update);
        let claim = viewports.resize(2, size(200, 60), Intent::Claim);
        assert_eq!(claim.apply, Some(size(200, 60)));
        assert_eq!(claim.transfer, Some((Some(1), Some(2))));
        assert_eq!(
            viewports.resize(1, size(90, 30), Intent::Update),
            Decision::default()
        );
    }

    #[test]
    fn input_moves_ownership_to_a_registered_attachment_only() {
        let mut viewports = Viewports::default();
        viewports.resize(1, size(80, 24), Intent::Update);
        viewports.resize(2, size(200, 60), Intent::Update);
        assert_eq!(viewports.input(3), Decision::default());
        let typed = viewports.input(2);
        assert_eq!(typed.apply, Some(size(200, 60)));
        assert_eq!(typed.transfer, Some((Some(1), Some(2))));
    }

    #[test]
    fn detaching_the_owner_hands_off_to_the_latest_claimant() {
        let mut viewports = Viewports::default();
        viewports.resize(1, size(80, 24), Intent::Update);
        viewports.resize(2, size(100, 30), Intent::Update);
        viewports.resize(3, size(120, 40), Intent::Update);
        viewports.resize(3, size(120, 40), Intent::Claim);
        viewports.resize(2, size(100, 30), Intent::Claim);
        let handoff = viewports.detach(2);
        assert_eq!(handoff.apply, Some(size(120, 40)));
        assert_eq!(handoff.transfer, Some((Some(2), Some(3))));
        assert_eq!(viewports.detach(1), Decision::default());
        let last = viewports.detach(3);
        assert_eq!(last.apply, None);
        assert_eq!(last.transfer, Some((Some(3), None)));
        // Detaching again, or an unknown attachment, is a no-op.
        assert_eq!(viewports.detach(3), Decision::default());
    }

    #[test]
    fn handoff_breaks_claim_ties_by_registration() {
        let mut viewports = Viewports::default();
        viewports.resize(1, size(80, 24), Intent::Update);
        viewports.resize(2, size(100, 30), Intent::Update);
        viewports.resize(3, size(120, 40), Intent::Update);
        // Neither 2 nor 3 has claimed; the later registration wins.
        assert_eq!(viewports.detach(1).transfer, Some((Some(1), Some(3))));
    }

    #[test]
    fn a_stale_or_malformed_incarnation_is_refused() {
        assert_eq!(fence("run-b", &json!({"op": "input"})), Ok(()));
        assert_eq!(fence("run-b", &json!({"run_id": null})), Ok(()));
        assert_eq!(fence("run-b", &json!({"run_id": "run-b"})), Ok(()));
        assert_eq!(
            fence("run-b", &json!({"run_id": "run-a"})),
            Err(Refusal::Stale)
        );
        assert_eq!(fence("run-b", &json!({"run_id": 7})), Err(Refusal::Stale));
        assert_eq!(fence("run-b", &json!({"run_id": ""})), Err(Refusal::Stale));
    }

    #[test]
    fn effects_on_an_exited_incarnation_are_refused_after_the_stale_check() {
        assert_eq!(fence_effect("run-b", true, &json!({})), Ok(()));
        assert_eq!(
            fence_effect("run-b", false, &json!({"run_id": "run-b"})),
            Err(Refusal::Exited)
        );
        assert_eq!(
            fence_effect("run-b", false, &json!({"run_id": "run-a"})),
            Err(Refusal::Stale)
        );
    }
}
