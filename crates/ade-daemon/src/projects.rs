//! What a workspace's folder is, read from the Git layout on disk: whether it
//! is a primary checkout or a linked worktree, and the branch its `HEAD`
//! names. No Git child runs, so the daemon can look again every tick and
//! notice a `git switch` made outside ADE.
use ade_core::model::WorkspaceKind;
use std::{io::Read, path::Path};

/// The largest `.git` pointer or `HEAD` file read, in bytes.
const SMALL_FILE: u64 = 4096;

/// A workspace's kind and branch. `repository` says the workspace belongs to
/// a Git repository project; a plain folder is always a folder with no branch.
pub fn inspect(root: &str, repository: bool) -> (WorkspaceKind, Option<String>) {
    if !repository {
        return (WorkspaceKind::Folder, None);
    }
    match git_dir(Path::new(root)) {
        Some((kind, git_dir)) => (
            kind,
            small_file(&git_dir.join("HEAD"))
                .as_deref()
                .and_then(ade_core::workspaces::head_branch),
        ),
        // The folder is gone or no longer a checkout: keep it a checkout of
        // its repository, with no branch to show.
        None => (WorkspaceKind::PrimaryCheckout, None),
    }
}

/// The checkout's own Git directory: `.git` of a primary checkout, the
/// directory a linked worktree's `.git` file points to, or a bare
/// repository itself. The nearest ancestor holding `.git` decides.
fn git_dir(root: &Path) -> Option<(WorkspaceKind, std::path::PathBuf)> {
    for ancestor in root.ancestors() {
        let dot_git = ancestor.join(".git");
        let Ok(metadata) = std::fs::metadata(&dot_git) else {
            continue;
        };
        if metadata.is_dir() {
            return Some((WorkspaceKind::PrimaryCheckout, dot_git));
        }
        let pointer = small_file(&dot_git)?;
        let target = pointer
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("gitdir: ")?;
        let target = Path::new(target);
        let target = if target.is_absolute() {
            target.to_path_buf()
        } else {
            ancestor.join(target)
        };
        return Some((WorkspaceKind::LinkedWorktree, target));
    }
    (root.join("HEAD").is_file() && root.join("objects").is_dir())
        .then(|| (WorkspaceKind::PrimaryCheckout, root.to_path_buf()))
}

fn small_file(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(SMALL_FILE + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= SMALL_FILE).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(crate::model::new_id(name));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn the_git_layout_names_the_kind_and_the_branch() {
        let base = scratch("ade-projects");
        let main = base.join("app");
        std::fs::create_dir_all(main.join(".git/worktrees/feature")).unwrap();
        std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let text = |path: &Path| path.to_str().unwrap().to_owned();
        assert_eq!(
            inspect(&text(&main), true),
            (WorkspaceKind::PrimaryCheckout, Some("main".into()))
        );
        // A subfolder workspace belongs to the checkout around it.
        std::fs::create_dir_all(main.join("docs")).unwrap();
        assert_eq!(
            inspect(&text(&main.join("docs")), true).0,
            WorkspaceKind::PrimaryCheckout
        );
        let linked = base.join("app-feature");
        std::fs::create_dir_all(&linked).unwrap();
        let admin = main.join(".git/worktrees/feature");
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", admin.display()),
        )
        .unwrap();
        std::fs::write(admin.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
        assert_eq!(
            inspect(&text(&linked), true),
            (WorkspaceKind::LinkedWorktree, Some("feature".into()))
        );
        // A detached HEAD names no branch.
        std::fs::write(
            admin.join("HEAD"),
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n",
        )
        .unwrap();
        assert_eq!(inspect(&text(&linked), true).1, None);
        // A plain folder never has one, even inside a checkout.
        assert_eq!(
            inspect(&text(&main.join("docs")), false),
            (WorkspaceKind::Folder, None)
        );
        std::fs::remove_dir_all(base).unwrap();
    }
}
