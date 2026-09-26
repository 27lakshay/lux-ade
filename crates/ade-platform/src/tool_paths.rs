//! Host-installed tool locations available to a Finder-launched desktop.
use std::{collections::BTreeSet, fs, path::PathBuf};

pub fn host_tool_dirs() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(value) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&value));
    }
    directories.extend(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            .into_iter()
            .map(PathBuf::from),
    );
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.extend(
            [".local/bin", ".bun/bin", ".local/share/mise/shims"]
                .into_iter()
                .map(|path| home.join(path)),
        );
        for (base, suffix) in [
            (".local/share/mise/installs/node", "bin"),
            (".local/share/mise/installs/pnpm", "bin"),
            (".local/share/mise/installs/yarn", "bin"),
            (".nvm/versions/node", "bin"),
            (".fnm/node-versions", "installation/bin"),
        ] {
            if let Ok(entries) = fs::read_dir(home.join(base)) {
                let mut paths = entries
                    .flatten()
                    .map(|entry| entry.path().join(suffix))
                    .collect::<Vec<_>>();
                paths.sort();
                paths.reverse();
                directories.extend(paths);
            }
        }
    }
    let mut seen = BTreeSet::new();
    directories.retain(|path| path.is_dir() && seen.insert(path.clone()));
    directories
}
