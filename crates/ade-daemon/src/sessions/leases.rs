//! Ownership reconciliation for daemon-owned session leases after a restart.
//!
//! A lease is the durable claim that some execution (an Agent run, a service
//! run or a script run) still occupies a workspace. After a daemon restart the
//! daemon compares each claim with what the runtime reports and resolves it to
//! one of three verdicts. Only `Live` and `Released` are proof; anything the
//! daemon cannot prove is `Uncertain`, which keeps the worktree lease and
//! refuses conflicting admission until a later observation settles it.
//! The verdict vocabulary follows Orca's `src/shared/pty-liveness-verdict.ts`
//! (studied, not copied): exit needs positive evidence of absence.
use super::*;
use crate::agent_runtime::Spec;

/// What a durable lease claims to hold.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum LeaseKey {
    Agent(String),
    Service {
        workspace_id: String,
        name: String,
    },
    Script {
        workspace_id: String,
        run_id: String,
    },
}

/// The execution identity a persisted lease expects to find in the runtime.
#[derive(Clone, Debug)]
pub(super) enum Holder {
    Terminal {
        terminal_id: String,
        /// The terminal incarnation; `None` when the durable record has none.
        transfer_id: Option<String>,
        /// The runtime incarnation that launched it, when recorded.
        runtime_instance: Option<String>,
    },
    Agent {
        run: Option<String>,
        provider: String,
        account: Option<String>,
    },
}

#[derive(Clone, Debug)]
pub(super) struct Claim {
    pub key: LeaseKey,
    pub workspace_id: String,
    pub root: String,
    pub holder: Holder,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Liveness {
    Running,
    Exited,
    /// The runtime could not verify the exit (for example an unknown exit status).
    Unknown,
}

#[derive(Clone, Debug)]
pub(super) struct ObservedTerminal {
    pub workspace_id: String,
    pub terminal_id: String,
    pub root: String,
    pub transfer_id: Option<String>,
    pub liveness: Liveness,
}

#[derive(Clone, Debug)]
pub(super) struct ObservedAgent {
    pub conversation_id: String,
    pub run: String,
    pub provider: String,
    pub account: Option<String>,
    pub root: String,
}

/// The runtime's state at one instant. `agents` is `None` when it was not observed.
#[derive(Clone, Debug)]
pub(super) struct Observation {
    pub runtime_instance: String,
    pub terminals: Vec<ObservedTerminal>,
    pub agents: Option<Vec<ObservedAgent>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Release {
    /// The current runtime incarnation reports no such execution.
    Absent,
    /// The runtime reports the same incarnation as exited.
    Exited,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Verdict {
    Live,
    Released(Release),
    Uncertain(String),
}

/// Resolves one persisted lease against one runtime observation.
pub(super) fn decide(claim: &Claim, observed: &Observation) -> Verdict {
    match &claim.holder {
        Holder::Terminal {
            terminal_id,
            transfer_id,
            runtime_instance,
        } => {
            if let Some(instance) = runtime_instance
                && *instance != observed.runtime_instance
            {
                // Another runtime incarnation may still run it; this one cannot see it.
                return Verdict::Uncertain(format!(
                    "it was launched by runtime {instance}, and the current runtime is {}",
                    observed.runtime_instance
                ));
            }
            let Some(terminal) = observed
                .terminals
                .iter()
                .find(|t| t.workspace_id == claim.workspace_id && t.terminal_id == *terminal_id)
            else {
                return Verdict::Released(Release::Absent);
            };
            if terminal.root != claim.root {
                return Verdict::Uncertain(
                    "the runtime terminal belongs to another workspace root".into(),
                );
            }
            match (&terminal.transfer_id, transfer_id) {
                (None, _) => {
                    return Verdict::Uncertain(
                        "the runtime terminal has no incarnation identity".into(),
                    );
                }
                (Some(actual), Some(expected)) if actual != expected => {
                    return Verdict::Uncertain(
                        "the runtime terminal is another incarnation".into(),
                    );
                }
                _ => {}
            }
            match terminal.liveness {
                Liveness::Running => Verdict::Live,
                Liveness::Exited => Verdict::Released(Release::Exited),
                Liveness::Unknown => {
                    Verdict::Uncertain("the runtime could not verify its exit".into())
                }
            }
        }
        Holder::Agent {
            run,
            provider,
            account,
        } => {
            let Some(agents) = &observed.agents else {
                return Verdict::Uncertain("the runtime Agent catalogue was not observed".into());
            };
            let Some(agent) = agents
                .iter()
                .find(|a| matches!(&claim.key, LeaseKey::Agent(id) if *id == a.conversation_id))
            else {
                return Verdict::Released(Release::Absent);
            };
            if run.as_deref() == Some(agent.run.as_str())
                && agent.provider == *provider
                && agent.account == *account
                && agent.root == claim.root
            {
                Verdict::Live
            } else {
                Verdict::Uncertain(
                    "the runtime Agent does not match its durable Conversation".into(),
                )
            }
        }
    }
}

/// Resolves every claim, and marks every observed Agent that no claim covers
/// as an uncertain orphan so its workspace stays leased.
pub(super) fn reconcile(claims: &[Claim], observed: &Observation) -> Vec<(Claim, Verdict)> {
    let mut plan: Vec<_> = claims
        .iter()
        .map(|claim| (claim.clone(), decide(claim, observed)))
        .collect();
    for agent in observed.agents.iter().flatten() {
        let key = LeaseKey::Agent(agent.conversation_id.clone());
        if claims.iter().any(|claim| claim.key == key) {
            continue;
        }
        plan.push((
            Claim {
                key,
                workspace_id: String::new(),
                root: agent.root.clone(),
                holder: Holder::Agent {
                    run: Some(agent.run.clone()),
                    provider: agent.provider.clone(),
                    account: agent.account.clone(),
                },
            },
            Verdict::Uncertain("the runtime Agent has no durable Conversation".into()),
        ));
    }
    plan
}

/// Reads one terminal's metrics. Only a reaped process with a known exit status
/// is `Exited`; the runtime reports `unknown` while it verifies the process
/// tree and when a descendant may still run.
pub(super) fn terminal_liveness(metrics: &Value) -> Liveness {
    if metrics["shell_running"] == true {
        Liveness::Running
    } else if metrics["shell_running"] == false
        && matches!(
            metrics["exit_status"]["kind"].as_str(),
            Some("success" | "failure" | "signaled")
        )
    {
        Liveness::Exited
    } else {
        Liveness::Unknown
    }
}

/// Reads the runtime's `terminal.list` reply.
pub(super) fn observe_terminals(catalogue: &Value) -> Result<Vec<ObservedTerminal>> {
    catalogue["terminals"]
        .as_array()
        .context("Invalid terminal catalogue")?
        .iter()
        .map(|item| {
            let text = |value: &Value| value.as_str().map(str::to_owned);
            let metrics = &item["metrics"];
            let liveness = terminal_liveness(metrics);
            Ok(ObservedTerminal {
                workspace_id: text(&item["workspace"]["id"])
                    .context("Invalid terminal catalogue")?,
                terminal_id: text(&item["workspace"]["terminal_id"])
                    .context("Invalid terminal catalogue")?,
                root: text(&item["workspace"]["root"]).unwrap_or_default(),
                transfer_id: text(&metrics["transfer_id"]),
                liveness,
            })
        })
        .collect()
}

/// Reads the runtime's `agent.list` reply, keeping each record for attachment.
pub(super) fn observe_agents(catalogue: &Value) -> Result<Vec<(ObservedAgent, Spec, Value)>> {
    catalogue["agents"]
        .as_array()
        .context("Invalid Agent catalogue")?
        .iter()
        .map(|record| {
            let spec: Spec = serde_json::from_value(record["spec"].clone())?;
            Ok((
                ObservedAgent {
                    conversation_id: spec.conversation.clone(),
                    run: spec.run.clone(),
                    provider: spec.provider.clone(),
                    account: spec.account.as_ref().map(|account| account.id.clone()),
                    root: spec.root.clone(),
                },
                spec,
                record["commands"].clone(),
            ))
        })
        .collect()
}

/// A lease the daemon could not resolve. It keeps its worktree lease.
pub(super) struct Unresolved {
    pub claim: Claim,
    pub reason: String,
    pub lease: Option<crate::worktrees::Lease>,
}

impl Sessions {
    /// Refuses admission that would conflict with an unresolved lease.
    pub(super) fn ensure_lease_resolved(d: &Data, key: &LeaseKey) -> Result<()> {
        if let Some(unresolved) = d.unresolved.get(key) {
            bail!(
                "Execution ownership is unresolved: {}. ADE will not start conflicting work until the runtime confirms it has stopped",
                unresolved.reason
            );
        }
        Ok(())
    }

    /// Refuses a new script run while any script run in the workspace is unresolved.
    pub(super) fn ensure_scripts_resolved(d: &Data, workspace_id: &str) -> Result<()> {
        for (key, unresolved) in &d.unresolved {
            if matches!(key, LeaseKey::Script { workspace_id: w, .. } if w == workspace_id) {
                bail!(
                    "A script run's ownership is unresolved after a daemon restart: {}. Stop or retire it before starting another",
                    unresolved.reason
                );
            }
        }
        Ok(())
    }

    /// Records a lease as unresolved. The worktree lease is held when the path exists.
    pub(super) fn hold_unresolved(&self, d: &mut Data, claim: Claim, reason: String) {
        eprintln!("Session lease unresolved: {:?}: {reason}", claim.key);
        let lease = self.worktrees.lease(&claim.root).ok();
        d.unresolved.insert(
            claim.key.clone(),
            Unresolved {
                claim,
                reason,
                lease,
            },
        );
    }

    /// Re-observes the runtime and settles unresolved leases that now have proof.
    pub(super) fn reconcile_unresolved(&self) -> Result<()> {
        let (claims, needs_agents) = {
            let d = self.data.lock().unwrap();
            if d.unresolved.is_empty() {
                return Ok(());
            }
            // Runtime restart reconciliation settles the leases it watches.
            let claims: Vec<Claim> = d
                .unresolved
                .values()
                .filter(|u| !d.recovery.holds(&u.claim.key))
                .map(|u| u.claim.clone())
                .collect();
            if claims.is_empty() {
                return Ok(());
            }
            let needs_agents = claims
                .iter()
                .any(|claim| matches!(claim.holder, Holder::Agent { .. }));
            (claims, needs_agents)
        };
        let observed = Observation {
            runtime_instance: self.runtime.instance.clone(),
            terminals: observe_terminals(&self.runtime.command(TerminalCommand::List)?)?,
            agents: if needs_agents {
                Some(
                    observe_agents(&self.runtime.agent(AgentOp::List)?)?
                        .into_iter()
                        .map(|(agent, _, _)| agent)
                        .collect(),
                )
            } else {
                None
            },
        };
        let mut d = self.data.lock().unwrap();
        for claim in claims {
            let verdict = decide(&claim, &observed);
            // An Agent that stays mismatched never becomes attachable; only its exit settles it.
            if matches!(verdict, Verdict::Uncertain(_))
                || matches!((&claim.key, &verdict), (LeaseKey::Agent(_), Verdict::Live))
            {
                continue;
            }
            let Some(unresolved) = d.unresolved.remove(&claim.key) else {
                continue;
            };
            eprintln!("Session lease settled: {:?}: {verdict:?}", claim.key);
            match (&claim.key, &claim.holder, verdict) {
                (
                    LeaseKey::Script {
                        workspace_id,
                        run_id,
                    },
                    _,
                    Verdict::Released(Release::Absent),
                ) => {
                    d.store.retire_script_run(workspace_id, run_id)?;
                    self.catalog_changed(&mut d)?;
                }
                (_, Holder::Terminal { terminal_id, .. }, Verdict::Live) => {
                    if let Some(lease) = unresolved.lease {
                        d.terminal_leases.insert(terminal_id.clone(), lease);
                    }
                }
                // A service keeps its durable reservation until service.stop
                // releases it; an exited Agent was already marked interrupted.
                _ => {}
            }
        }
        Ok(())
    }

    /// Drops an unresolved lease once a control path has settled it. A lease
    /// restart reconciliation watches needs the `resolution` that
    /// [`Sessions::recovery_control_release`] returned first.
    pub(super) fn settle_unresolved(
        &self,
        d: &mut Data,
        key: &LeaseKey,
        resolution: Option<String>,
    ) {
        d.unresolved.remove(key);
        self.recovery_lease_settled(d, key, resolution);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal(transfer: Option<&str>, liveness: Liveness) -> ObservedTerminal {
        ObservedTerminal {
            workspace_id: "w".into(),
            terminal_id: "t".into(),
            root: "/r".into(),
            transfer_id: transfer.map(str::to_owned),
            liveness,
        }
    }
    fn service(transfer: &str, instance: &str) -> Claim {
        Claim {
            key: LeaseKey::Service {
                workspace_id: "w".into(),
                name: "web".into(),
            },
            workspace_id: "w".into(),
            root: "/r".into(),
            holder: Holder::Terminal {
                terminal_id: "t".into(),
                transfer_id: Some(transfer.into()),
                runtime_instance: Some(instance.into()),
            },
        }
    }
    fn script() -> Claim {
        Claim {
            key: LeaseKey::Script {
                workspace_id: "w".into(),
                run_id: "t".into(),
            },
            workspace_id: "w".into(),
            root: "/r".into(),
            holder: Holder::Terminal {
                terminal_id: "t".into(),
                transfer_id: None,
                runtime_instance: None,
            },
        }
    }
    fn agent_claim(run: Option<&str>) -> Claim {
        Claim {
            key: LeaseKey::Agent("c".into()),
            workspace_id: "w".into(),
            root: "/r".into(),
            holder: Holder::Agent {
                run: run.map(str::to_owned),
                provider: "codex".into(),
                account: None,
            },
        }
    }
    fn agent(conversation: &str, run: &str) -> ObservedAgent {
        ObservedAgent {
            conversation_id: conversation.into(),
            run: run.into(),
            provider: "codex".into(),
            account: None,
            root: "/r".into(),
        }
    }
    fn observed(
        terminals: Vec<ObservedTerminal>,
        agents: Option<Vec<ObservedAgent>>,
    ) -> Observation {
        Observation {
            runtime_instance: "i1".into(),
            terminals,
            agents,
        }
    }

    #[test]
    fn a_running_terminal_of_the_same_incarnation_is_live() {
        let now = observed(vec![terminal(Some("x"), Liveness::Running)], None);
        assert_eq!(decide(&service("x", "i1"), &now), Verdict::Live);
        assert_eq!(decide(&script(), &now), Verdict::Live);
    }

    #[test]
    fn exit_and_absence_under_the_same_runtime_release_the_lease() {
        let exited = observed(vec![terminal(Some("x"), Liveness::Exited)], None);
        assert_eq!(
            decide(&service("x", "i1"), &exited),
            Verdict::Released(Release::Exited)
        );
        let empty = observed(vec![], None);
        assert_eq!(
            decide(&service("x", "i1"), &empty),
            Verdict::Released(Release::Absent)
        );
        assert_eq!(
            decide(&script(), &empty),
            Verdict::Released(Release::Absent)
        );
    }

    #[test]
    fn another_runtime_incarnation_is_never_proof_of_exit() {
        // Absence from a replacement runtime says nothing about the old one.
        let empty = observed(vec![], None);
        assert!(matches!(
            decide(&service("x", "i0"), &empty),
            Verdict::Uncertain(_)
        ));
    }

    #[test]
    fn a_changed_or_missing_terminal_incarnation_is_uncertain() {
        let other = observed(vec![terminal(Some("y"), Liveness::Exited)], None);
        assert!(matches!(
            decide(&service("x", "i1"), &other),
            Verdict::Uncertain(_)
        ));
        let anonymous = observed(vec![terminal(None, Liveness::Running)], None);
        assert!(matches!(
            decide(&script(), &anonymous),
            Verdict::Uncertain(_)
        ));
    }

    #[test]
    fn an_unverified_exit_or_foreign_root_is_uncertain() {
        let unknown = observed(vec![terminal(Some("x"), Liveness::Unknown)], None);
        assert!(matches!(decide(&script(), &unknown), Verdict::Uncertain(_)));
        let mut moved = terminal(Some("x"), Liveness::Running);
        moved.root = "/elsewhere".into();
        assert!(matches!(
            decide(&service("x", "i1"), &observed(vec![moved], None)),
            Verdict::Uncertain(_)
        ));
    }

    #[test]
    fn agent_runs_resolve_by_run_identity() {
        let live = observed(vec![], Some(vec![agent("c", "run_1")]));
        assert_eq!(decide(&agent_claim(Some("run_1")), &live), Verdict::Live);
        assert!(matches!(
            decide(&agent_claim(Some("run_0")), &live),
            Verdict::Uncertain(_)
        ));
        assert!(matches!(
            decide(&agent_claim(None), &live),
            Verdict::Uncertain(_)
        ));
        let gone = observed(vec![], Some(vec![]));
        assert_eq!(
            decide(&agent_claim(Some("run_1")), &gone),
            Verdict::Released(Release::Absent)
        );
    }

    #[test]
    fn an_unobserved_agent_catalogue_is_not_proof_of_absence() {
        let blind = observed(vec![], None);
        assert!(matches!(
            decide(&agent_claim(Some("run_1")), &blind),
            Verdict::Uncertain(_)
        ));
    }

    #[test]
    fn an_orphan_runtime_agent_holds_its_workspace() {
        let now = observed(
            vec![],
            Some(vec![agent("c", "run_1"), agent("ghost", "run_9")]),
        );
        let plan = reconcile(&[agent_claim(Some("run_1"))], &now);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].1, Verdict::Live);
        assert_eq!(plan[1].0.key, LeaseKey::Agent("ghost".into()));
        assert_eq!(plan[1].0.root, "/r");
        assert!(matches!(plan[1].1, Verdict::Uncertain(_)));
    }
}
