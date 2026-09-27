//! Pure ownership decisions: where each provider reads skills, and what the
//! catalog may do at a path given what is there and who owns it. The rule is
//! D14's: never overwrite or delete externally owned files without explicit
//! adoption.
use ade_core::contract::skills::{SkillObservedPlacement, SkillPlacementDecision, SkillScope};
use std::path::{Path, PathBuf};

/// Provider skill roots, relative to the home or workspace directory.
///
/// Sources: Claude Code reads `.claude/skills`; Codex reads `.agents/skills`
/// and `$CODEX_HOME/skills`; OpenCode reads `skill` and `skills` under its
/// config directories (opencode-v2 `config/plugin/skill.ts`); Oh My Pi reads
/// `~/.omp/agent/skills` and `.omp/skills` (oh-my-pi `discovery/builtin.ts`).
/// Account-specific homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) are not modelled
/// yet: these are the default locations only.
const ROOTS: &[(&str, SkillScope, &str)] = &[
    ("claude", SkillScope::Global, ".claude/skills"),
    ("claude", SkillScope::Workspace, ".claude/skills"),
    ("codex", SkillScope::Global, ".codex/skills"),
    ("codex", SkillScope::Global, ".agents/skills"),
    ("codex", SkillScope::Workspace, ".agents/skills"),
    ("opencode", SkillScope::Global, ".config/opencode/skills"),
    ("opencode", SkillScope::Global, ".config/opencode/skill"),
    ("opencode", SkillScope::Workspace, ".opencode/skills"),
    ("opencode", SkillScope::Workspace, ".opencode/skill"),
    ("omp", SkillScope::Global, ".omp/agent/skills"),
    ("omp", SkillScope::Workspace, ".omp/skills"),
];

/// One provider skill root on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
    pub provider: &'static str,
    pub scope: SkillScope,
    pub path: PathBuf,
}

/// Every provider skill root for the home directory and, when given, one
/// workspace, in a fixed order.
pub fn provider_roots(home: &Path, workspace: Option<&Path>) -> Vec<Root> {
    ROOTS
        .iter()
        .filter_map(|(provider, scope, relative)| {
            let base = match scope {
                SkillScope::Global => home,
                SkillScope::Workspace => workspace?,
            };
            Some(Root {
                provider,
                scope: *scope,
                path: base.join(relative),
            })
        })
        .collect()
}

/// What is at a provider path, as the filesystem showed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Seen {
    Absent,
    /// A real directory. `content_hash` is `None` when it is not a valid bundle.
    Directory {
        content_hash: Option<String>,
    },
    /// A symbolic link, file or other entry that is not a plain directory.
    Other,
    Unreadable,
}

/// What a placement of the bundle hashed `bundle` would need at a path.
/// `adopted` is the content hash recorded when the catalog adopted the path.
pub fn decide(
    seen: &Seen,
    adopted: Option<&str>,
    bundle: &str,
) -> (
    SkillObservedPlacement,
    SkillPlacementDecision,
    Option<&'static str>,
) {
    use SkillObservedPlacement as O;
    use SkillPlacementDecision as D;
    match (seen, adopted) {
        (Seen::Absent, _) => (O::Absent, D::Create, None),
        (Seen::Unreadable, _) => (
            O::Unreadable,
            D::Refuse,
            Some("The path could not be read; inspect it before placing"),
        ),
        (Seen::Other, _) => (
            O::ExternalOther,
            D::Refuse,
            Some("The path is a link or file; ADE never replaces it"),
        ),
        (Seen::Directory { content_hash }, Some(recorded)) => {
            if content_hash.as_deref() != Some(recorded) {
                (
                    O::AdoptedDrifted,
                    D::Refuse,
                    Some("The adopted directory changed since adoption; adopt it again"),
                )
            } else if recorded == bundle {
                (O::AdoptedUnchanged, D::UpToDate, None)
            } else {
                (O::AdoptedUnchanged, D::Replace, None)
            }
        }
        (Seen::Directory { content_hash }, None) => {
            if content_hash.as_deref() == Some(bundle) {
                (
                    O::ExternalIdentical,
                    D::UpToDate,
                    Some("Identical content, still externally owned"),
                )
            } else {
                (
                    O::ExternalDifferent,
                    D::RequiresAdoption,
                    Some("Another owner's skill is here; adopt it explicitly first"),
                )
            }
        }
    }
}

/// What an install does to the catalog entry of the same name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallPlan {
    Insert,
    Unchanged,
    Replace,
}

/// Decides an install of a bundle hashed `new` when the catalog holds
/// `current` under its name. Replacing needs the caller to name the hash it
/// replaces, so a stale caller cannot overwrite a newer install.
pub fn plan_install(
    current: Option<&str>,
    new: &str,
    expected: Option<&str>,
    replace: Option<&str>,
) -> Result<InstallPlan, String> {
    if let Some(expected) = expected
        && expected != new
    {
        return Err(format!(
            "The source now hashes to {new}, not the pinned {expected}; inspect it before installing"
        ));
    }
    match current {
        None if replace.is_some() => {
            Err("No bundle of this name is installed; omit the replace hash".into())
        }
        None => Ok(InstallPlan::Insert),
        Some(current) if current == new => Ok(InstallPlan::Unchanged),
        Some(current) if replace == Some(current) => Ok(InstallPlan::Replace),
        Some(current) => Err(format!(
            "A different bundle of this name is installed ({current}); pass its hash to replace it"
        )),
    }
}

/// The catalog state an adoption is checked against.
pub struct AdoptionContext<'a> {
    pub roots: &'a [Root],
    pub path: &'a Path,
    pub seen: &'a Seen,
    pub expected_hash: &'a str,
    pub name: &'a str,
    /// The content hash of the installed bundle with this name.
    pub installed: Option<&'a str>,
    /// The bundle name that already owns this path.
    pub adopted_by: Option<&'a str>,
}

/// What adoption records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdoptionPlan {
    /// Copy the directory into the catalog and own the path.
    InstallAndOwn,
    /// The bundle is already installed with this content; only own the path.
    Own,
    /// Already adopted with this content.
    Unchanged,
}

/// Decides an explicit adoption. Adoption takes only a plain directory
/// directly inside a provider skill root, exactly as discovery reported it.
pub fn plan_adoption(context: &AdoptionContext) -> Result<AdoptionPlan, String> {
    let parent = context.path.parent();
    if !context
        .roots
        .iter()
        .any(|root| Some(root.path.as_path()) == parent)
    {
        return Err("Only a skill directly inside a provider skill root can be adopted".into());
    }
    let hash = match context.seen {
        Seen::Directory {
            content_hash: Some(hash),
        } => hash.as_str(),
        Seen::Directory { content_hash: None } => {
            return Err("The directory is not a valid skill bundle".into());
        }
        Seen::Absent => return Err("The skill directory no longer exists".into()),
        Seen::Other => {
            return Err(
                "Only a plain directory can be adopted; adopt the link target's own path".into(),
            );
        }
        Seen::Unreadable => return Err("The skill directory could not be read".into()),
    };
    if hash != context.expected_hash {
        return Err(format!(
            "The directory now hashes to {hash}, not {}; discover it again",
            context.expected_hash
        ));
    }
    if let Some(owner) = context.adopted_by
        && owner != context.name
    {
        return Err(format!("The path is already adopted by {owner}"));
    }
    match context.installed {
        Some(installed) if installed != hash => Err(format!(
            "A different bundle named {} is installed; remove or replace it first",
            context.name
        )),
        Some(_) if context.adopted_by.is_some() => Ok(AdoptionPlan::Unchanged),
        Some(_) => Ok(AdoptionPlan::Own),
        None => Ok(AdoptionPlan::InstallAndOwn),
    }
}

/// What `skill.place` does, decided from what [`decide`] saw at the path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlacePlan {
    /// Write the bundle into the absent path and own it.
    Create,
    /// Swap ADE's own unchanged placement for the bundle.
    Replace,
    /// The owned path already holds the bundle; write nothing.
    UpToDate,
    /// An external directory holds identical content; write nothing, own nothing.
    ExternalIdentical,
}

/// Decides a placement. Anything but an absent path or an unchanged
/// catalog-owned one is refused with the projection's reason, so an external
/// skill is never written over (D14).
pub fn plan_place(
    observed: SkillObservedPlacement,
    decision: SkillPlacementDecision,
    reason: Option<&str>,
) -> Result<PlacePlan, String> {
    use SkillObservedPlacement as O;
    use SkillPlacementDecision as D;
    match (observed, decision) {
        (_, D::Create) => Ok(PlacePlan::Create),
        (_, D::Replace) => Ok(PlacePlan::Replace),
        (O::ExternalIdentical, D::UpToDate) => Ok(PlacePlan::ExternalIdentical),
        (_, D::UpToDate) => Ok(PlacePlan::UpToDate),
        (_, D::RequiresAdoption | D::Refuse) => Err(reason
            .unwrap_or("The provider path cannot take this skill")
            .to_owned()),
    }
}

/// Whether a placement interrupted by a crash provably finished: the path
/// now holds exactly the bundle it was writing. Anything else is unknown.
pub fn placement_finished(seen: &Seen, content_hash: &str) -> bool {
    matches!(seen, Seen::Directory { content_hash: Some(found) } if found == content_hash)
}

/// Checks a removal against the installed bundle's hash.
pub fn check_remove(installed: Option<&str>, expected: &str) -> Result<(), String> {
    match installed {
        None => Err("No bundle of this name is installed".into()),
        Some(installed) if installed != expected => Err(format!(
            "The installed bundle is {installed}, not {expected}; inspect it again"
        )),
        Some(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use SkillObservedPlacement as O;
    use SkillPlacementDecision as D;

    fn dir(hash: Option<&str>) -> Seen {
        Seen::Directory {
            content_hash: hash.map(str::to_owned),
        }
    }

    #[test]
    fn roots_cover_each_provider_and_scope_workspace_only_when_given() {
        let home = Path::new("/h");
        let global = provider_roots(home, None);
        assert!(global.iter().all(|root| root.scope == SkillScope::Global));
        for provider in ["claude", "codex", "opencode", "omp"] {
            assert!(global.iter().any(|root| root.provider == provider));
        }
        assert_eq!(global[0].path, Path::new("/h/.claude/skills"));
        let both = provider_roots(home, Some(Path::new("/w")));
        let workspace: Vec<_> = both
            .iter()
            .filter(|root| root.scope == SkillScope::Workspace)
            .collect();
        assert!(!workspace.is_empty());
        assert!(workspace.iter().all(|root| root.path.starts_with("/w")));
    }

    #[test]
    fn placement_never_changes_external_files_without_adoption() {
        assert_eq!(decide(&Seen::Absent, None, "b").1, D::Create);
        assert_eq!(decide(&Seen::Absent, Some("a"), "b").1, D::Create);
        let (observed, decision, _) = decide(&dir(Some("x")), None, "b");
        assert_eq!(
            (observed, decision),
            (O::ExternalDifferent, D::RequiresAdoption)
        );
        let (observed, decision, _) = decide(&dir(None), None, "b");
        assert_eq!(
            (observed, decision),
            (O::ExternalDifferent, D::RequiresAdoption)
        );
        let (observed, decision, _) = decide(&dir(Some("b")), None, "b");
        assert_eq!((observed, decision), (O::ExternalIdentical, D::UpToDate));
        for seen in [Seen::Other, Seen::Unreadable] {
            assert_eq!(decide(&seen, None, "b").1, D::Refuse);
            assert_eq!(decide(&seen, Some("b"), "b").1, D::Refuse);
        }
    }

    #[test]
    fn adopted_paths_are_replaceable_only_while_unchanged() {
        let (observed, decision, _) = decide(&dir(Some("a")), Some("a"), "b");
        assert_eq!((observed, decision), (O::AdoptedUnchanged, D::Replace));
        let (observed, decision, _) = decide(&dir(Some("b")), Some("b"), "b");
        assert_eq!((observed, decision), (O::AdoptedUnchanged, D::UpToDate));
        let (observed, decision, _) = decide(&dir(Some("edited")), Some("a"), "b");
        assert_eq!((observed, decision), (O::AdoptedDrifted, D::Refuse));
        let (observed, decision, _) = decide(&dir(None), Some("a"), "b");
        assert_eq!((observed, decision), (O::AdoptedDrifted, D::Refuse));
    }

    #[test]
    fn install_pins_and_replaces_only_the_named_hash() {
        assert_eq!(plan_install(None, "n", None, None), Ok(InstallPlan::Insert));
        assert_eq!(
            plan_install(None, "n", Some("n"), None),
            Ok(InstallPlan::Insert)
        );
        assert!(plan_install(None, "n", Some("old"), None).is_err());
        assert!(plan_install(None, "n", None, Some("c")).is_err());
        assert_eq!(
            plan_install(Some("n"), "n", None, None),
            Ok(InstallPlan::Unchanged)
        );
        assert!(plan_install(Some("c"), "n", None, None).is_err());
        assert!(plan_install(Some("c"), "n", None, Some("stale")).is_err());
        assert_eq!(
            plan_install(Some("c"), "n", None, Some("c")),
            Ok(InstallPlan::Replace)
        );
    }

    #[test]
    fn adoption_takes_only_what_discovery_reported() {
        let roots = provider_roots(Path::new("/h"), None);
        let seen = dir(Some("h1"));
        let base = AdoptionContext {
            roots: &roots,
            path: Path::new("/h/.claude/skills/pdf"),
            seen: &seen,
            expected_hash: "h1",
            name: "pdf",
            installed: None,
            adopted_by: None,
        };
        assert_eq!(plan_adoption(&base), Ok(AdoptionPlan::InstallAndOwn));
        let installed = AdoptionContext {
            installed: Some("h1"),
            ..base
        };
        assert_eq!(plan_adoption(&installed), Ok(AdoptionPlan::Own));
        let owned = AdoptionContext {
            installed: Some("h1"),
            adopted_by: Some("pdf"),
            ..base
        };
        assert_eq!(plan_adoption(&owned), Ok(AdoptionPlan::Unchanged));

        let outside = AdoptionContext {
            path: Path::new("/h/projects/pdf"),
            ..base
        };
        assert!(
            plan_adoption(&outside)
                .unwrap_err()
                .contains("provider skill root")
        );
        let nested = AdoptionContext {
            path: Path::new("/h/.claude/skills/a/pdf"),
            ..base
        };
        assert!(plan_adoption(&nested).is_err());
        let changed = AdoptionContext {
            expected_hash: "h0",
            ..base
        };
        assert!(
            plan_adoption(&changed)
                .unwrap_err()
                .contains("discover it again")
        );
        let other_install = AdoptionContext {
            installed: Some("h2"),
            ..base
        };
        assert!(
            plan_adoption(&other_install)
                .unwrap_err()
                .contains("different bundle")
        );
        let other_owner = AdoptionContext {
            adopted_by: Some("docs"),
            ..base
        };
        assert!(
            plan_adoption(&other_owner)
                .unwrap_err()
                .contains("already adopted")
        );
        for seen in [Seen::Other, Seen::Absent, Seen::Unreadable, dir(None)] {
            let context = AdoptionContext {
                seen: &seen,
                ..base
            };
            assert!(plan_adoption(&context).is_err(), "{seen:?}");
        }
    }

    #[test]
    fn removal_needs_the_installed_hash() {
        assert!(check_remove(None, "a").is_err());
        assert!(check_remove(Some("b"), "a").is_err());
        assert!(check_remove(Some("a"), "a").is_ok());
    }

    #[test]
    fn placement_writes_only_an_absent_or_owned_unchanged_path() {
        let plan = |seen: &Seen, adopted: Option<&str>| {
            let (observed, decision, reason) = decide(seen, adopted, "h");
            plan_place(observed, decision, reason)
        };
        assert_eq!(plan(&Seen::Absent, None), Ok(PlacePlan::Create));
        assert_eq!(plan(&dir(Some("old")), Some("old")), Ok(PlacePlan::Replace));
        assert_eq!(plan(&dir(Some("h")), Some("h")), Ok(PlacePlan::UpToDate));
        assert_eq!(
            plan(&dir(Some("h")), None),
            Ok(PlacePlan::ExternalIdentical)
        );
        // External, drifted, non-directory and unreadable paths are never written.
        for (seen, adopted) in [
            (dir(Some("other")), None),
            (dir(None), None),
            (dir(Some("edited")), Some("old")),
            (Seen::Other, None),
            (Seen::Unreadable, None),
        ] {
            assert!(plan(&seen, adopted).is_err(), "{seen:?} {adopted:?}");
        }
    }

    #[test]
    fn an_interrupted_placement_is_finished_only_with_the_exact_bundle() {
        assert!(placement_finished(&dir(Some("h")), "h"));
        assert!(!placement_finished(&dir(Some("old")), "h"));
        assert!(!placement_finished(&dir(None), "h"));
        assert!(!placement_finished(&Seen::Absent, "h"));
        assert!(!placement_finished(&Seen::Other, "h"));
    }
}
