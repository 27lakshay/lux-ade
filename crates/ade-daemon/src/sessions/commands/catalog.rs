//! Pure command and skill decisions (F037): which paths each provider reads
//! commands from, whether it loads a scope, how ADE hands an entry to it, and
//! how observed files, provider skills and ADE's catalog merge into one listing.
//!
//! The native forms below are the ones each provider interprets itself when it
//! arrives as ordinary user input through the adapter ADE already runs:
//!
//! - Claude Agent SDK 0.3.281: a prompt that starts with `/name` runs the
//!   command or skill of that name (`SlashCommand`, "invoked via /command
//!   syntax"). The SDK loads user and project files only for the setting
//!   sources the Conversation enables.
//! - Oh My Pi RPC `prompt`: `/name` runs a file command, and `/skill:name`
//!   runs a skill while `skills.enableSkillCommands` is on (its default).
//! - Codex 0.157.0 app-server: takes a skill as a `skill` turn input item and
//!   has no slash commands; custom prompts are expanded by the Codex TUI only.
//! - OpenCode v2: runs commands through its session command path and takes
//!   skills in the prompt's `skills` field.
//!
//! ADE's Codex and OpenCode adapters send neither form, so those entries are
//! unavailable. ADE never turns a command into an ordinary prompt of its own.
use ade_core::contract::commands::{
    CommandEntry, CommandKind, CommandNativeCatalog, CommandProvenance, CommandSource,
};
use ade_core::contract::skills::SkillScope;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Longest argument text ADE queues after a command.
pub const ARGUMENTS_LIMIT: usize = 16 * 1024;

/// Command directories, relative to the home or workspace directory.
///
/// Sources: Claude Code reads `.claude/commands`; Oh My Pi reads `commands`
/// under `~/.omp/agent` and `.omp` (oh-my-pi `discovery/builtin.ts`); OpenCode
/// reads `command` and `commands` under its config directories (oh-my-pi
/// `discovery/opencode.ts`); Codex reads custom prompts from `~/.codex/prompts`.
const COMMAND_ROOTS: &[(&str, SkillScope, &str)] = &[
    ("claude", SkillScope::Global, ".claude/commands"),
    ("claude", SkillScope::Workspace, ".claude/commands"),
    ("omp", SkillScope::Global, ".omp/agent/commands"),
    ("omp", SkillScope::Workspace, ".omp/commands"),
    ("opencode", SkillScope::Global, ".config/opencode/command"),
    ("opencode", SkillScope::Global, ".config/opencode/commands"),
    ("opencode", SkillScope::Workspace, ".opencode/command"),
    ("opencode", SkillScope::Workspace, ".opencode/commands"),
    ("codex", SkillScope::Global, ".codex/prompts"),
];

/// One command directory on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandRoot {
    pub scope: SkillScope,
    pub path: PathBuf,
}

/// The command directories `provider` reads. `home` is `None` when the
/// Conversation runs under an ADE-managed account, whose native home this
/// listing does not read.
pub fn command_roots(provider: &str, home: Option<&Path>, workspace: &Path) -> Vec<CommandRoot> {
    COMMAND_ROOTS
        .iter()
        .filter(|(owner, _, _)| *owner == provider)
        .filter_map(|(_, scope, relative)| {
            let base = match scope {
                SkillScope::Global => home?,
                SkillScope::Workspace => workspace,
            };
            Some(CommandRoot {
                scope: *scope,
                path: base.join(relative),
            })
        })
        .collect()
}

/// What the daemon knows about the Conversation when it decides.
#[derive(Clone, Copy, Debug)]
pub struct Facts<'a> {
    pub provider: &'a str,
    /// The Conversation's provider setting sources (Claude only).
    pub setting_sources: &'a [String],
}

/// An entry read from a provider path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub name: String,
    pub kind: CommandKind,
    pub scope: SkillScope,
    pub path: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub content_hash: Option<String>,
    /// Why the entry is not a usable command or skill.
    pub problem: Option<String>,
}

/// A bundle in ADE's skill catalog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Catalogued {
    pub name: String,
    pub description: String,
    pub content_hash: String,
}

/// The native path ADE uses for `kind` on `provider`, or why it has none.
pub fn mechanism(provider: &str, kind: CommandKind) -> Result<&'static str, String> {
    use CommandKind::*;
    match (provider, kind) {
        ("claude", Command | Skill) => Ok("claude.prompt_slash"),
        ("omp", Command) => Ok("omp.prompt_slash"),
        ("omp", Skill) => Ok("omp.prompt_skill_command"),
        ("codex", Command) => Err(
            "Codex app-server has no slash commands; custom prompts are expanded only by the Codex TUI"
                .into(),
        ),
        ("codex", Skill) => Err(
            "Codex takes a skill as a skill turn input item, which ADE's Codex adapter does not send yet"
                .into(),
        ),
        ("opencode", Command) => Err(
            "OpenCode runs commands through its session command path, which ADE's OpenCode bridge does not call yet"
                .into(),
        ),
        ("opencode", Skill) => Err(
            "OpenCode takes skills in the prompt's skills field, which ADE's OpenCode bridge does not send yet"
                .into(),
        ),
        (other, _) => Err(format!("Unknown provider {other}")),
    }
}

/// The text the provider receives for `name` without arguments.
pub fn invocation(provider: &str, kind: CommandKind, name: &str) -> String {
    match (provider, kind) {
        ("omp", CommandKind::Skill) => format!("/skill:{name}"),
        _ => format!("/{name}"),
    }
}

/// The exact text queued for the provider.
pub fn native_text(invocation: &str, arguments: &str) -> String {
    let arguments = arguments.trim();
    if arguments.is_empty() {
        invocation.to_owned()
    } else {
        format!("{invocation} {arguments}")
    }
}

/// Why the provider does not load entries from `scope`, if it does not.
fn scope_refusal(facts: &Facts, scope: SkillScope) -> Option<String> {
    if facts.provider != "claude" {
        return None;
    }
    let (source, label) = match scope {
        SkillScope::Global => ("user", "user"),
        SkillScope::Workspace => ("project", "project"),
    };
    (!facts.setting_sources.iter().any(|s| s == source)).then(|| {
        format!(
            "This Conversation starts Claude without the {source} setting source, so Claude does not load {label} commands or skills"
        )
    })
}

/// A name the provider can parse as one command token.
pub fn valid_command_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && name.len() <= 64
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Rejects argument text the provider could not receive as typed input.
pub fn check_arguments(arguments: &str) -> Result<(), String> {
    if arguments.len() > ARGUMENTS_LIMIT {
        return Err("Arguments exceed 16 KiB".into());
    }
    if arguments
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err("Arguments contain a control character".into());
    }
    Ok(())
}

/// What the provider itself could report, which ADE does not ask for yet.
pub fn native_catalog(provider: &str) -> CommandNativeCatalog {
    let (method, what) = match provider {
        "claude" => (
            Some("Query.supportedCommands()"),
            "Claude's built-in, plugin and MCP commands",
        ),
        "omp" => (
            Some("get_available_commands"),
            "Oh My Pi's built-in, extension and MCP commands",
        ),
        "codex" => (Some("skills/list"), "Codex's plugin and system skills"),
        "opencode" => (None, "OpenCode's configured and plugin commands"),
        _ => (None, "The provider's own commands"),
    };
    CommandNativeCatalog {
        method: method.map(str::to_owned),
        queried: false,
        reason: format!(
            "ADE does not ask the live provider session for its command list yet. {what} are not listed and cannot be invoked through ADE"
        ),
    }
}

fn kind_label(kind: CommandKind) -> &'static str {
    match kind {
        CommandKind::Command => "command",
        CommandKind::Skill => "skill",
    }
}

/// Merges what was read into one listing. An entry is invocable only when
/// its provider has a native form ADE sends, the provider loads its scope,
/// and no other invocable entry uses the same native text.
pub fn merge(facts: &Facts, found: Vec<Found>, catalog: &[Catalogued]) -> Vec<CommandEntry> {
    let mut entries: Vec<CommandEntry> = found
        .into_iter()
        .map(|found| {
            let catalog_name = found.content_hash.as_ref().and_then(|hash| {
                catalog
                    .iter()
                    .find(|bundle| &bundle.content_hash == hash)
                    .map(|bundle| bundle.name.clone())
            });
            let refusal = found
                .problem
                .clone()
                .or_else(|| {
                    (!valid_command_name(&found.name))
                        .then(|| format!("{} cannot be typed as a command name", found.name))
                })
                .map(Err)
                .unwrap_or_else(|| mechanism(facts.provider, found.kind))
                .and_then(|mechanism| match scope_refusal(facts, found.scope) {
                    Some(reason) => Err(reason),
                    None => Ok(mechanism),
                });
            let (invocable, invocation_text, mechanism_name, reason) = match refusal {
                Ok(mechanism) => (
                    true,
                    Some(invocation(facts.provider, found.kind, &found.name)),
                    Some(mechanism.to_owned()),
                    (facts.provider == "omp" && found.kind == CommandKind::Skill).then(|| {
                        "Oh My Pi runs it only while its skills.enableSkillCommands setting is on, which is the default".to_owned()
                    }),
                ),
                Err(reason) => (false, None, None, Some(reason)),
            };
            CommandEntry {
                name: found.name,
                kind: found.kind,
                description: found.description,
                argument_hint: found.argument_hint,
                provenance: CommandProvenance {
                    source: match found.kind {
                        CommandKind::Command => CommandSource::ProviderFile,
                        CommandKind::Skill => CommandSource::ProviderSkill,
                    },
                    scope: Some(found.scope),
                    path: Some(found.path),
                    content_hash: found.content_hash,
                    catalog_name,
                },
                invocable,
                invocation: invocation_text,
                mechanism: mechanism_name,
                reason,
            }
        })
        .collect();

    // Two invocable entries behind one native text: ADE cannot tell which
    // one the provider runs, so neither is offered.
    let mut uses: HashMap<String, usize> = HashMap::new();
    for entry in entries.iter().filter(|entry| entry.invocable) {
        *uses
            .entry(entry.invocation.clone().unwrap_or_default())
            .or_default() += 1;
    }
    for entry in &mut entries {
        let Some(text) = entry.invocation.clone() else {
            continue;
        };
        let count = uses.get(&text).copied().unwrap_or(0);
        if count > 1 {
            entry.invocable = false;
            entry.mechanism = None;
            entry.invocation = None;
            entry.reason = Some(format!(
                "{count} entries use {text}; ADE cannot tell which one the provider runs"
            ));
        }
    }

    for bundle in catalog {
        if entries
            .iter()
            .any(|entry| entry.provenance.catalog_name.as_deref() == Some(bundle.name.as_str()))
        {
            continue;
        }
        entries.push(CommandEntry {
            name: bundle.name.clone(),
            kind: CommandKind::Skill,
            description: Some(bundle.description.clone()),
            argument_hint: None,
            provenance: CommandProvenance {
                source: CommandSource::AdeCatalog,
                scope: None,
                path: None,
                content_hash: Some(bundle.content_hash.clone()),
                catalog_name: Some(bundle.name.clone()),
            },
            invocable: false,
            invocation: None,
            mechanism: None,
            reason: Some(format!(
                "Installed in ADE's skill catalog but not in a path {} reads; ADE does not place skills yet",
                facts.provider
            )),
        });
    }
    entries.sort_by(|a, b| {
        (kind_label(a.kind), &a.name, &a.provenance.path).cmp(&(
            kind_label(b.kind),
            &b.name,
            &b.provenance.path,
        ))
    });
    entries
}

/// What an invocation request resolves to in a listing.
#[derive(Debug, PartialEq)]
pub enum Resolution<'a> {
    Invoke(&'a CommandEntry),
    /// Listed, but not invocable; the reason says why.
    Unavailable(String),
    /// Not in the listing at all.
    Missing(String),
}

pub fn resolve<'a>(entries: &'a [CommandEntry], name: &str, kind: CommandKind) -> Resolution<'a> {
    let named: Vec<_> = entries
        .iter()
        .filter(|entry| entry.name == name && entry.kind == kind)
        .collect();
    if let Some(entry) = named.iter().find(|entry| entry.invocable) {
        return Resolution::Invoke(entry);
    }
    match named.first() {
        Some(entry) => Resolution::Unavailable(
            entry
                .reason
                .clone()
                .unwrap_or_else(|| "The entry cannot be invoked".into()),
        ),
        None => Resolution::Missing(format!(
            "No {} named {name} is available to this Conversation; list its commands again",
            kind_label(kind)
        )),
    }
}

/// Reads `description` and `argument-hint` from a command file's optional
/// frontmatter. Only single-line plain or quoted values are read; any other
/// form leaves the field empty, since both are informational.
pub fn command_file_meta(text: &str) -> (Option<String>, Option<String>) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (None, None);
    }
    let mut description = None;
    let mut hint = None;
    for line in lines {
        let line = line.trim_end();
        if line == "---" {
            return (description, hint);
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let slot = match key {
            "description" => &mut description,
            "argument-hint" => &mut hint,
            _ => continue,
        };
        *slot = single_line(value.trim());
    }
    // An unclosed block is not frontmatter.
    (None, None)
}

fn single_line(value: &str) -> Option<String> {
    let unquoted = match value.as_bytes() {
        [b'"', .., b'"'] | [b'\'', .., b'\''] if value.len() >= 2 => &value[1..value.len() - 1],
        _ if value.starts_with(['|', '>', '[', '{', '"', '\'']) => return None,
        _ => value,
    };
    (!unquoted.is_empty()).then(|| unquoted.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(name: &str, kind: CommandKind, scope: SkillScope, path: &str) -> Found {
        Found {
            name: name.into(),
            kind,
            scope,
            path: path.into(),
            description: None,
            argument_hint: None,
            content_hash: None,
            problem: None,
        }
    }

    fn sources(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn roots_follow_the_provider_and_skip_an_unread_home() {
        let roots = command_roots("claude", Some(Path::new("/h")), Path::new("/w"));
        assert_eq!(
            roots,
            vec![
                CommandRoot {
                    scope: SkillScope::Global,
                    path: "/h/.claude/commands".into()
                },
                CommandRoot {
                    scope: SkillScope::Workspace,
                    path: "/w/.claude/commands".into()
                },
            ]
        );
        let managed = command_roots("opencode", None, Path::new("/w"));
        assert!(
            managed
                .iter()
                .all(|root| root.scope == SkillScope::Workspace)
        );
        assert_eq!(managed.len(), 2);
        assert!(command_roots("codex", None, Path::new("/w")).is_empty());
    }

    #[test]
    fn claude_invokes_by_slash_only_for_loaded_setting_sources() {
        let enabled = sources(&["user", "project"]);
        let facts = Facts {
            provider: "claude",
            setting_sources: &enabled,
        };
        let entries = merge(
            &facts,
            vec![
                found(
                    "review",
                    CommandKind::Command,
                    SkillScope::Workspace,
                    "/w/.claude/commands/review.md",
                ),
                found(
                    "pdf",
                    CommandKind::Skill,
                    SkillScope::Global,
                    "/h/.claude/skills/pdf",
                ),
            ],
            &[],
        );
        assert!(entries.iter().all(|entry| entry.invocable));
        assert_eq!(entries[0].invocation.as_deref(), Some("/review"));
        assert_eq!(entries[1].invocation.as_deref(), Some("/pdf"));

        let none = Facts {
            provider: "claude",
            setting_sources: &[],
        };
        let entries = merge(
            &none,
            vec![found(
                "review",
                CommandKind::Command,
                SkillScope::Workspace,
                "/w/.claude/commands/review.md",
            )],
            &[],
        );
        assert!(!entries[0].invocable);
        assert!(entries[0].reason.as_deref().unwrap().contains("project"));
        assert_eq!(entries[0].invocation, None);
    }

    #[test]
    fn providers_without_a_native_form_report_it_and_never_offer_a_prompt() {
        for provider in ["codex", "opencode", "gemini"] {
            let facts = Facts {
                provider,
                setting_sources: &[],
            };
            let entries = merge(
                &facts,
                vec![
                    found("a", CommandKind::Command, SkillScope::Workspace, "/w/a.md"),
                    found("b", CommandKind::Skill, SkillScope::Workspace, "/w/b"),
                ],
                &[],
            );
            for entry in entries {
                assert!(!entry.invocable, "{provider}");
                assert!(entry.invocation.is_none() && entry.mechanism.is_none());
                assert!(entry.reason.is_some());
            }
        }
    }

    #[test]
    fn oh_my_pi_prefixes_skills_and_carries_the_setting_caveat() {
        let facts = Facts {
            provider: "omp",
            setting_sources: &[],
        };
        let entries = merge(
            &facts,
            vec![
                found("pdf", CommandKind::Skill, SkillScope::Global, "/h/pdf"),
                found("pdf", CommandKind::Command, SkillScope::Global, "/h/pdf.md"),
            ],
            &[],
        );
        // A skill and a command of one name do not collide in Oh My Pi.
        assert!(entries.iter().all(|entry| entry.invocable));
        assert_eq!(entries[0].invocation.as_deref(), Some("/pdf"));
        assert_eq!(entries[1].invocation.as_deref(), Some("/skill:pdf"));
        assert!(
            entries[1]
                .reason
                .as_deref()
                .unwrap()
                .contains("enableSkillCommands")
        );
    }

    #[test]
    fn entries_sharing_a_native_text_are_all_withheld() {
        let enabled = sources(&["user", "project"]);
        let facts = Facts {
            provider: "claude",
            setting_sources: &enabled,
        };
        let entries = merge(
            &facts,
            vec![
                found("fix", CommandKind::Command, SkillScope::Global, "/h/fix.md"),
                found("fix", CommandKind::Skill, SkillScope::Workspace, "/w/fix"),
                found("ok", CommandKind::Command, SkillScope::Global, "/h/ok.md"),
            ],
            &[],
        );
        let fix: Vec<_> = entries.iter().filter(|entry| entry.name == "fix").collect();
        assert_eq!(fix.len(), 2);
        assert!(fix.iter().all(|entry| {
            !entry.invocable
                && entry
                    .reason
                    .as_deref()
                    .unwrap()
                    .starts_with("2 entries use /fix")
        }));
        assert!(
            entries
                .iter()
                .any(|entry| entry.name == "ok" && entry.invocable)
        );
        assert!(matches!(
            resolve(&entries, "fix", CommandKind::Skill),
            Resolution::Unavailable(_)
        ));
    }

    #[test]
    fn problems_and_untypable_names_are_listed_but_not_invocable() {
        let enabled = sources(&["user", "project"]);
        let facts = Facts {
            provider: "claude",
            setting_sources: &enabled,
        };
        let mut broken = found("bad", CommandKind::Skill, SkillScope::Global, "/h/bad");
        broken.problem = Some("SKILL.md is missing".into());
        let entries = merge(
            &facts,
            vec![
                broken,
                found(
                    "two words",
                    CommandKind::Command,
                    SkillScope::Global,
                    "/h/x.md",
                ),
            ],
            &[],
        );
        assert!(entries.iter().all(|entry| !entry.invocable));
        assert!(
            entries
                .iter()
                .any(|entry| entry.reason.as_deref() == Some("SKILL.md is missing"))
        );
    }

    #[test]
    fn catalog_bundles_annotate_matching_skills_or_list_as_unplaced() {
        let enabled = sources(&["user"]);
        let facts = Facts {
            provider: "claude",
            setting_sources: &enabled,
        };
        let mut placed = found("pdf", CommandKind::Skill, SkillScope::Global, "/h/pdf");
        placed.content_hash = Some("h1".into());
        let catalog = vec![
            Catalogued {
                name: "pdf".into(),
                description: "Reads PDFs".into(),
                content_hash: "h1".into(),
            },
            Catalogued {
                name: "xlsx".into(),
                description: "Sheets".into(),
                content_hash: "h2".into(),
            },
        ];
        let entries = merge(&facts, vec![placed], &catalog);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].provenance.catalog_name.as_deref(), Some("pdf"));
        assert!(entries[0].invocable);
        assert_eq!(entries[1].provenance.source, CommandSource::AdeCatalog);
        assert!(!entries[1].invocable);
        assert!(matches!(
            resolve(&entries, "xlsx", CommandKind::Skill),
            Resolution::Unavailable(_)
        ));
    }

    #[test]
    fn resolution_distinguishes_missing_from_unavailable() {
        let enabled = sources(&["user"]);
        let facts = Facts {
            provider: "claude",
            setting_sources: &enabled,
        };
        let entries = merge(
            &facts,
            vec![found(
                "go",
                CommandKind::Command,
                SkillScope::Global,
                "/h/go.md",
            )],
            &[],
        );
        assert!(matches!(
            resolve(&entries, "go", CommandKind::Command),
            Resolution::Invoke(entry) if entry.invocation.as_deref() == Some("/go")
        ));
        assert!(matches!(
            resolve(&entries, "go", CommandKind::Skill),
            Resolution::Missing(_)
        ));
        assert!(matches!(
            resolve(&entries, "gone", CommandKind::Command),
            Resolution::Missing(_)
        ));
    }

    #[test]
    fn native_text_appends_trimmed_arguments_once() {
        assert_eq!(native_text("/review", ""), "/review");
        assert_eq!(native_text("/review", "  \n"), "/review");
        assert_eq!(native_text("/skill:pdf", " a.pdf "), "/skill:pdf a.pdf");
        assert_eq!(invocation("omp", CommandKind::Skill, "pdf"), "/skill:pdf");
        assert_eq!(invocation("claude", CommandKind::Skill, "pdf"), "/pdf");
    }

    #[test]
    fn arguments_and_names_are_checked() {
        assert!(check_arguments("line one\nline\ttwo").is_ok());
        assert!(check_arguments("nul\0").is_err());
        assert!(check_arguments(&"x".repeat(ARGUMENTS_LIMIT + 1)).is_err());
        assert!(valid_command_name("review-pr_2.v1"));
        for bad in ["", "-x", "a b", "a/b", "/x", &"x".repeat(65)] {
            assert!(!valid_command_name(bad), "{bad}");
        }
    }

    #[test]
    fn command_file_meta_reads_simple_frontmatter_only() {
        assert_eq!(
            command_file_meta(
                "---\ndescription: Review a file\nargument-hint: \"<file>\"\nmodel: x\n---\nBody"
            ),
            (Some("Review a file".into()), Some("<file>".into()))
        );
        assert_eq!(command_file_meta("Body only"), (None, None));
        assert_eq!(command_file_meta("---\ndescription: open"), (None, None));
        assert_eq!(
            command_file_meta("---\ndescription: |\n  block\n---\n"),
            (None, None)
        );
    }

    #[test]
    fn every_provider_names_what_it_does_not_list() {
        for provider in ["claude", "omp", "codex", "opencode"] {
            let native = native_catalog(provider);
            assert!(!native.queried);
            assert!(native.reason.contains("not listed"));
        }
    }
}
