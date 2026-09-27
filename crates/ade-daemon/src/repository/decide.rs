//! Pure clone and publish logic: remote URL validation, the clone destination
//! rule, the publish plan and the reconciliation of interrupted receipts.
use ade_core::contract::repository::{
    RepositoryCoverage, RepositoryPublishStep, RepositoryPublishVerdict, RepositoryTransport,
    TransportCoverage,
};
use std::path::{Component, Path};

const MAX_URL_BYTES: usize = 2048;

/// A remote URL ADE accepts, with the transport it was recognised as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteUrl {
    pub transport: RepositoryTransport,
    pub url: String,
}

/// Classifies a remote URL and refuses anything ADE does not support.
///
/// Refused: surrounding or embedded whitespace and control characters, a
/// leading `-` (Git would read it as an option), passwords in the URL (they
/// would be stored in receipts and Git config; use a credential helper),
/// unencrypted `http://` and `git://`, `<helper>::` remote helpers such as
/// `ext::`, which run commands, and bare local paths.
pub fn parse_remote_url(input: &str) -> Result<RemoteUrl, String> {
    let refuse = |reason: &str| Err(reason.to_owned());
    if input.is_empty() {
        return refuse("Remote URL is empty");
    }
    if input.len() > MAX_URL_BYTES {
        return refuse("Remote URL is longer than 2048 bytes");
    }
    if input.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return refuse("Remote URL must not contain spaces or control characters");
    }
    if input.starts_with('-') {
        return refuse("Remote URL must not start with '-'");
    }
    let accepted = |transport| {
        Ok(RemoteUrl {
            transport,
            url: input.to_owned(),
        })
    };
    if let Some((scheme, rest)) = input.split_once("://") {
        if scheme.contains("::") {
            return refuse("Git remote helpers such as ext:: are not supported");
        }
        return match scheme.to_ascii_lowercase().as_str() {
            "https" => authority(rest).and_then(|()| accepted(RepositoryTransport::Https)),
            "ssh" | "git+ssh" | "ssh+git" => {
                authority(rest).and_then(|()| accepted(RepositoryTransport::Ssh))
            }
            "file" => {
                if !rest.starts_with('/') || rest.len() < 2 {
                    return refuse("file:// URLs must name an absolute path");
                }
                accepted(RepositoryTransport::File)
            }
            "http" => refuse("Unencrypted http:// is not supported; use https:// or SSH"),
            "git" => {
                refuse("The unauthenticated git:// protocol is not supported; use https:// or SSH")
            }
            _ => refuse("Unsupported URL scheme; use https://, ssh://, user@host:path or file://"),
        };
    }
    if input.contains("::") {
        return refuse("Git remote helpers such as ext:: are not supported");
    }
    // Git reads `host:path` as SSH when no slash comes before the first colon.
    if let Some((host_part, path)) = input.split_once(':')
        && !host_part.contains('/')
    {
        let host = host_part
            .rsplit_once('@')
            .map_or(host_part, |(_, host)| host);
        if host.is_empty()
            || host.starts_with('-')
            || (host.starts_with('[') && !host.ends_with(']'))
        {
            return refuse("SSH remote has no valid host");
        }
        if host_part.matches('@').count() > 1 {
            return refuse("SSH remote has more than one user name");
        }
        if path.is_empty() {
            return refuse("SSH remote has no repository path");
        }
        return accepted(RepositoryTransport::ScpLike);
    }
    refuse("Local paths are not accepted; use a file:// URL")
}

/// Checks the part after `scheme://`: a host, no password, and a repository path.
fn authority(rest: &str) -> Result<(), String> {
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(end);
    let host = match authority.rsplit_once('@') {
        Some((user, host)) => {
            if user.contains(':') {
                return Err(
                    "Remote URL contains a password; store credentials in a Git credential helper instead"
                        .into(),
                );
            }
            if user.contains('@') {
                return Err("Remote URL has more than one user name".into());
            }
            host
        }
        None => authority,
    };
    let host_name = host.strip_prefix('[').map_or_else(
        || host.split(':').next().unwrap_or(""),
        |ipv6| ipv6.split(']').next().unwrap_or(""),
    );
    if host_name.is_empty() || host_name.starts_with('-') {
        return Err("Remote URL has no valid host".into());
    }
    if path.trim_matches('/').is_empty() {
        return Err("Remote URL has no repository path".into());
    }
    Ok(())
}

/// A remote name ADE will add: short, and not something Git reads as an option.
pub fn valid_remote_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.contains("..")
        && !name.ends_with(".lock")
}

/// A conservative subset of Git's branch-name rules; the daemon also asks
/// `git check-ref-format`.
pub fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name != "@"
        && name.split('/').all(|part| !part.starts_with('.'))
        && !name.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
}

/// A commit message ADE writes: one line, at most 200 characters.
pub fn valid_commit_message(message: &str) -> bool {
    !message.trim().is_empty()
        && message.chars().count() <= 200
        && !message.chars().any(char::is_control)
}

/// What the filesystem says about a requested clone destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DestinationFacts {
    /// Anything at the path, including a broken symbolic link.
    pub exists: bool,
    pub parent_is_dir: bool,
}

/// The clone destination rule: an absolute, normalised path whose parent is a
/// directory and which does not exist yet. ADE never clones into, or over, an
/// existing path.
pub fn check_destination(path: &str, facts: DestinationFacts) -> Result<(), String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("Destination must be an absolute path".into());
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("Destination must not contain . or .. components".into());
    }
    if path.parent().is_none() || path.file_name().is_none() {
        return Err("Destination must name a new folder".into());
    }
    if !facts.parent_is_dir {
        return Err("Destination's parent folder does not exist".into());
    }
    if facts.exists {
        return Err("Destination already exists; choose a new folder".into());
    }
    Ok(())
}

/// What Git says about a folder about to be published.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublishFacts {
    /// The folder belongs to a Git work tree.
    pub in_repository: bool,
    /// The folder is that work tree's top level.
    pub is_toplevel: bool,
    pub is_bare: bool,
    /// HEAD names a commit.
    pub head_born: bool,
    /// The current branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The URL already configured for the chosen remote, as written in config.
    pub remote_url: Option<String>,
    /// A merge, rebase, cherry-pick, revert or bisect is in progress.
    pub operation_in_progress: bool,
    pub uncommitted_changes: bool,
}

/// What publish would do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishPlan {
    pub verdict: RepositoryPublishVerdict,
    pub branch: Option<String>,
    pub steps: Vec<RepositoryPublishStep>,
    pub blocked_reasons: Vec<String>,
}

impl PublishPlan {
    pub fn runs(&self, step: RepositoryPublishStep) -> bool {
        self.steps.contains(&step)
    }
}

/// Decides the publish steps from the folder's facts and the request.
pub fn plan_publish(
    facts: &PublishFacts,
    url: &str,
    initial_branch: &str,
    create_initial_commit: bool,
) -> PublishPlan {
    use RepositoryPublishStep as Step;
    let mut reasons = Vec::new();
    if facts.is_bare {
        reasons.push("The folder is a bare repository".to_owned());
    } else if facts.in_repository && !facts.is_toplevel {
        reasons.push(
            "The folder is inside another repository; publish that repository's top-level folder"
                .to_owned(),
        );
    }
    if facts.operation_in_progress {
        reasons.push("A merge, rebase or similar operation is in progress".to_owned());
    }
    if facts.in_repository && facts.branch.is_none() {
        reasons.push("HEAD is detached; check out a branch first".to_owned());
    }
    if let Some(existing) = &facts.remote_url
        && existing != url
    {
        reasons.push(format!(
            "The remote already points at {existing}; ADE does not change an existing remote"
        ));
    }
    let branch = if facts.in_repository {
        facts.branch.clone()
    } else {
        Some(initial_branch.to_owned())
    };
    let mut steps = Vec::new();
    if !facts.in_repository {
        steps.push(Step::Initialize);
    }
    let needs_commit = !facts.in_repository || !facts.head_born;
    if needs_commit {
        steps.push(Step::Commit);
    }
    if facts.remote_url.is_none() {
        steps.push(Step::AddRemote);
    }
    steps.extend([Step::Push, Step::Verify]);
    let verdict = if !reasons.is_empty() {
        RepositoryPublishVerdict::Blocked
    } else if needs_commit && !create_initial_commit {
        RepositoryPublishVerdict::NeedsInitialCommit
    } else {
        RepositoryPublishVerdict::Ready
    };
    PublishPlan {
        verdict,
        branch,
        steps,
        blocked_reasons: reasons,
    }
}

/// Compares a `git ls-remote` line set with the pushed commit.
pub fn remote_confirms(ls_remote: &str, reference: &str, commit: &str) -> bool {
    ls_remote.lines().any(|line| {
        line.split_once('\t')
            .is_some_and(|(sha, name)| sha == commit && name == reference)
    })
}

/// A receipt left open by an earlier daemon process, and what the disk shows now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClonePhase {
    /// `git clone` was started.
    Cloning,
    /// The clone was verified; registration had not been confirmed.
    Registering,
}

/// How to settle an interrupted clone receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloneReconcile {
    /// Nothing was written; report that and settle.
    NothingWritten,
    /// Something exists at the destination that ADE cannot prove complete.
    /// Settle as unknown; never delete it and never clone again under this ID.
    Unknown,
    /// The verified clone is still there; registration may be completed,
    /// because registering a folder is idempotent.
    Register,
    /// The verified clone is gone or is no longer the same repository.
    CloneMissing,
}

pub fn reconcile_clone(
    phase: ClonePhase,
    destination_exists: bool,
    still_repository: bool,
) -> CloneReconcile {
    match phase {
        ClonePhase::Cloning if !destination_exists => CloneReconcile::NothingWritten,
        ClonePhase::Cloning => CloneReconcile::Unknown,
        ClonePhase::Registering if destination_exists && still_repository => {
            CloneReconcile::Register
        }
        ClonePhase::Registering => CloneReconcile::CloneMissing,
    }
}

/// How to describe a clone whose `git clone` did not succeed.
pub fn clone_failure(exit_code: Option<i64>, destination_exists: bool) -> (bool, &'static str) {
    // Git removes the folder it created when clone exits with an error. A
    // killed or timed-out Git cannot, so anything left is reported, not removed.
    match (exit_code, destination_exists) {
        (Some(_), false) => (false, "Git clone failed; nothing was written"),
        (Some(_), true) => (
            true,
            "Git clone failed and left a folder at the destination; ADE did not remove it",
        ),
        (None, false) => (false, "Git clone was stopped; nothing was written"),
        (None, true) => (
            true,
            "Git clone was stopped before it finished; a partial folder remains at the destination and ADE did not remove it",
        ),
    }
}

/// The steps an interrupted publish receipt had reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishPhase {
    /// Initialise, commit or add-remote was running; nothing was pushed.
    Local,
    /// The push had been started.
    Pushing,
}

/// Interrupted local steps can be described from Git and are safe to continue
/// with a new operation ID; an interrupted push may have reached the remote.
pub fn publish_interrupted_is_unknown(phase: PublishPhase) -> bool {
    phase == PublishPhase::Pushing
}

/// How a push that ran settles, from its exit and the remote read-back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushSettlement {
    /// The remote branch is at the pushed commit.
    Published,
    /// Git reported success but the remote does not confirm it.
    VerifyFailed,
    /// Git exited with an error, so it refused the push.
    NotPushed,
    /// Git was killed or timed out and the remote does not confirm the
    /// commit. The push may have reached the remote, or receive-pack may still
    /// finish it, so this is not a definite failure.
    Unknown,
}

/// `push_exit` is Git's exit code, `None` when it was killed or timed out.
/// `confirmed` is the read-back: `Some(true)` at the commit, `Some(false)`
/// not at it, `None` unreadable.
pub fn push_settlement(push_exit: Option<i64>, confirmed: Option<bool>) -> PushSettlement {
    match (push_exit, confirmed) {
        (_, Some(true)) => PushSettlement::Published,
        (None, _) => PushSettlement::Unknown,
        (Some(0), _) => PushSettlement::VerifyFailed,
        (Some(_), _) => PushSettlement::NotPushed,
    }
}

/// D08: ordinary Git only, with named coverage.
pub fn coverage() -> RepositoryCoverage {
    use RepositoryTransport as T;
    let row = |transport, supported, example: &str, note: &str| TransportCoverage {
        transport,
        supported,
        example: example.into(),
        note: note.into(),
    };
    RepositoryCoverage {
        tag: Default::default(),
        transports: vec![
            row(T::Https, true, "https://host/owner/repo.git", "Credentials come from Git's credential helpers; a password in the URL is refused"),
            row(T::Ssh, true, "ssh://git@host/owner/repo.git", "Uses the SSH agent and keys; ADE never answers a host-key or passphrase prompt"),
            row(T::ScpLike, true, "git@host:owner/repo.git", "Git runs this over SSH"),
            row(T::File, true, "file:///srv/git/repo.git", "A repository on this machine"),
            row(T::Http, false, "http://host/repo.git", "Unencrypted"),
            row(T::GitDaemon, false, "git://host/repo.git", "Unauthenticated and unencrypted"),
            row(T::RemoteHelper, false, "ext::command", "Remote helpers can run arbitrary commands"),
            row(T::LocalPath, false, "/srv/git/repo.git", "Use file:// instead"),
        ],
        forge_apis: false,
        credentials: "The system git with the user's own credential helpers, SSH agent and keys. ADE stores no credential and never prompts.".into(),
        excluded: vec![
            "Creating the remote repository on a forge".into(),
            "Pull or merge request management and issue integration".into(),
            "Force push or overwriting an existing remote branch".into(),
            "Changing an existing remote's URL".into(),
            "Submodule checkout during clone".into(),
            "Cloning onto a remote host".into(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use RepositoryPublishStep as Step;

    fn transport(url: &str) -> RepositoryTransport {
        parse_remote_url(url)
            .unwrap_or_else(|e| panic!("{url}: {e}"))
            .transport
    }

    #[test]
    fn a_killed_push_that_the_remote_does_not_confirm_is_unknown() {
        use PushSettlement::*;
        // Killed or timed out, and ls-remote failed too: the push may have
        // reached the remote.
        assert_eq!(push_settlement(None, None), Unknown);
        // Killed, and the remote is not at the commit yet: receive-pack may
        // still finish.
        assert_eq!(push_settlement(None, Some(false)), Unknown);
        assert_eq!(push_settlement(None, Some(true)), Published);
        // Git's own refusal is definite.
        assert_eq!(push_settlement(Some(1), None), NotPushed);
        assert_eq!(push_settlement(Some(128), Some(false)), NotPushed);
        assert_eq!(push_settlement(Some(0), Some(true)), Published);
        assert_eq!(push_settlement(Some(0), Some(false)), VerifyFailed);
        assert_eq!(push_settlement(Some(0), None), VerifyFailed);
    }

    #[test]
    fn accepts_supported_transports() {
        assert_eq!(
            transport("https://github.com/a/b.git"),
            RepositoryTransport::Https
        );
        assert_eq!(
            transport("HTTPS://host:8443/a/b"),
            RepositoryTransport::Https
        );
        assert_eq!(transport("https://user@host/a"), RepositoryTransport::Https);
        assert_eq!(
            transport("https://[::1]:8080/a"),
            RepositoryTransport::Https
        );
        assert_eq!(
            transport("ssh://git@host:22/a/b.git"),
            RepositoryTransport::Ssh
        );
        assert_eq!(
            transport("git@github.com:a/b.git"),
            RepositoryTransport::ScpLike
        );
        assert_eq!(transport("host:repo"), RepositoryTransport::ScpLike);
        assert_eq!(
            transport("file:///srv/git/a.git"),
            RepositoryTransport::File
        );
    }

    #[test]
    fn refuses_unsafe_or_unsupported_urls() {
        for url in [
            "",
            " https://h/a",
            "https://h/a b",
            "https://h/a\n",
            "-uhttps://h/a",
            "--upload-pack=touch /tmp/x",
            "https://user:secret@h/a",
            "https://a@b@h/a",
            "https://h",
            "https://h/",
            "https:///a",
            "https://-h/a",
            "http://h/a",
            "git://h/a",
            "ext::sh -c touch% /tmp/x",
            "ext::sh",
            "fd::3",
            "foo::https://h/a",
            "ftp://h/a",
            "file://relative",
            "/srv/git/a.git",
            "./a",
            "@:a",
            "-host:a",
            "host:",
            "a@b@host:a",
        ] {
            assert!(parse_remote_url(url).is_err(), "{url:?} should be refused");
        }
        assert!(parse_remote_url(&format!("https://h/{}", "a".repeat(3000))).is_err());
    }

    #[test]
    fn names_are_checked() {
        assert!(valid_remote_name("origin"));
        assert!(valid_remote_name("up-stream_2"));
        for bad in [
            "",
            "-x",
            ".x",
            "a b",
            "a/b",
            "a..b",
            "x.lock",
            &"a".repeat(65),
        ] {
            assert!(!valid_remote_name(bad), "{bad:?}");
        }
        assert!(valid_branch_name("main"));
        assert!(valid_branch_name("feature/one"));
        for bad in [
            "", "-b", "a..b", "a b", "a~1", "a^", "a:b", "a/", "a.lock", "@", "a@{1}", "a/.b",
            "a//b",
        ] {
            assert!(!valid_branch_name(bad), "{bad:?}");
        }
        assert!(valid_commit_message("Initial commit"));
        assert!(!valid_commit_message("  "));
        assert!(!valid_commit_message("two\nlines"));
        assert!(!valid_commit_message(&"x".repeat(201)));
    }

    #[test]
    fn destination_must_be_new() {
        let fresh = DestinationFacts {
            exists: false,
            parent_is_dir: true,
        };
        assert!(check_destination("/work/new", fresh).is_ok());
        assert!(check_destination("work/new", fresh).is_err());
        assert!(check_destination("/work/../new", fresh).is_err());
        assert!(check_destination("/", fresh).is_err());
        let taken = DestinationFacts {
            exists: true,
            parent_is_dir: true,
        };
        assert!(
            check_destination("/work/new", taken)
                .unwrap_err()
                .contains("already exists")
        );
        let orphan = DestinationFacts {
            exists: false,
            parent_is_dir: false,
        };
        assert!(check_destination("/work/new", orphan).is_err());
    }

    fn repo(branch: &str) -> PublishFacts {
        PublishFacts {
            in_repository: true,
            is_toplevel: true,
            head_born: true,
            branch: Some(branch.into()),
            ..Default::default()
        }
    }

    #[test]
    fn plain_folder_initialises_commits_and_pushes() {
        let plan = plan_publish(&PublishFacts::default(), "u", "main", true);
        assert_eq!(plan.verdict, RepositoryPublishVerdict::Ready);
        assert_eq!(plan.branch.as_deref(), Some("main"));
        assert_eq!(
            plan.steps,
            [
                Step::Initialize,
                Step::Commit,
                Step::AddRemote,
                Step::Push,
                Step::Verify
            ]
        );
        let unconfirmed = plan_publish(&PublishFacts::default(), "u", "main", false);
        assert_eq!(
            unconfirmed.verdict,
            RepositoryPublishVerdict::NeedsInitialCommit
        );
    }

    #[test]
    fn existing_repository_pushes_current_branch() {
        let plan = plan_publish(&repo("trunk"), "u", "main", false);
        assert_eq!(plan.verdict, RepositoryPublishVerdict::Ready);
        assert_eq!(plan.branch.as_deref(), Some("trunk"));
        assert_eq!(plan.steps, [Step::AddRemote, Step::Push, Step::Verify]);
        let same_remote = PublishFacts {
            remote_url: Some("u".into()),
            ..repo("trunk")
        };
        assert_eq!(
            plan_publish(&same_remote, "u", "main", false).steps,
            [Step::Push, Step::Verify]
        );
        let unborn = PublishFacts {
            head_born: false,
            ..repo("main")
        };
        let plan = plan_publish(&unborn, "u", "main", false);
        assert_eq!(plan.verdict, RepositoryPublishVerdict::NeedsInitialCommit);
        assert!(plan.runs(Step::Commit) && !plan.runs(Step::Initialize));
    }

    #[test]
    fn unsafe_states_block() {
        let blocked = |facts: PublishFacts| {
            let plan = plan_publish(&facts, "u", "main", true);
            assert_eq!(plan.verdict, RepositoryPublishVerdict::Blocked, "{facts:?}");
            plan.blocked_reasons
        };
        let other = blocked(PublishFacts {
            remote_url: Some("other".into()),
            ..repo("main")
        });
        assert!(other[0].contains("other"));
        blocked(PublishFacts {
            branch: None,
            ..repo("main")
        });
        blocked(PublishFacts {
            is_toplevel: false,
            ..repo("main")
        });
        blocked(PublishFacts {
            is_bare: true,
            ..repo("main")
        });
        blocked(PublishFacts {
            operation_in_progress: true,
            ..repo("main")
        });
    }

    #[test]
    fn remote_confirmation_needs_exact_ref_and_commit() {
        let listing = "abc\trefs/heads/main\ndef\trefs/heads/mainline\n";
        assert!(remote_confirms(listing, "refs/heads/main", "abc"));
        assert!(!remote_confirms(listing, "refs/heads/main", "def"));
        assert!(!remote_confirms("", "refs/heads/main", "abc"));
    }

    #[test]
    fn interrupted_receipts_never_replay_blindly() {
        assert_eq!(
            reconcile_clone(ClonePhase::Cloning, false, false),
            CloneReconcile::NothingWritten
        );
        assert_eq!(
            reconcile_clone(ClonePhase::Cloning, true, true),
            CloneReconcile::Unknown
        );
        assert_eq!(
            reconcile_clone(ClonePhase::Registering, true, true),
            CloneReconcile::Register
        );
        assert_eq!(
            reconcile_clone(ClonePhase::Registering, true, false),
            CloneReconcile::CloneMissing
        );
        assert_eq!(
            reconcile_clone(ClonePhase::Registering, false, false),
            CloneReconcile::CloneMissing
        );
        assert!(publish_interrupted_is_unknown(PublishPhase::Pushing));
        assert!(!publish_interrupted_is_unknown(PublishPhase::Local));
        assert!(!clone_failure(Some(128), false).0);
        assert!(clone_failure(None, true).0);
    }

    #[test]
    fn coverage_declares_no_forge_apis() {
        let coverage = coverage();
        assert!(!coverage.forge_apis);
        assert!(
            coverage
                .transports
                .iter()
                .any(|t| t.transport == RepositoryTransport::Https && t.supported)
        );
        assert!(
            coverage
                .transports
                .iter()
                .any(|t| t.transport == RepositoryTransport::RemoteHelper && !t.supported)
        );
    }
}
