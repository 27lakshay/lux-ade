//! Locate installed resources independently of the working directory.
use std::path::{Path, PathBuf};

fn bundle_resources(executable: &Path) -> Option<PathBuf> {
    let binaries = executable.parent()?;
    let contents = binaries.parent()?;
    (binaries.file_name()? == "MacOS" && contents.file_name()? == "Contents")
        .then(|| contents.join("Resources"))
}

pub fn resource_root() -> PathBuf {
    if let Some(root) = std::env::var_os("ADE_RESOURCE_DIR") {
        return root.into();
    }
    if let Some(root) = std::env::current_exe()
        .ok()
        .and_then(|p| bundle_resources(&p))
    {
        return root;
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn resource(relative: &str) -> PathBuf {
    resource_root().join(relative)
}

pub fn runtime_home() -> PathBuf {
    std::env::var_os("ADE_RUNTIME_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            home.join("Library/Application Support/lux-ade/runtime")
        })
}

pub fn logs() -> PathBuf {
    std::env::var_os("ADE_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("ADE_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(runtime_home)
                .join("logs")
        })
}

pub fn sibling_binary(name: &str) -> std::io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    Ok(executable
        .parent()
        .ok_or_else(|| std::io::Error::other("Executable has no parent"))?
        .join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moved_bundle_uses_its_own_resources() {
        for root in ["/Applications/lux-ade.app", "/tmp/with spaces/lux-ade.app"] {
            let executable = Path::new(root).join("Contents/MacOS/ade-client");
            assert_eq!(
                bundle_resources(&executable),
                Some(Path::new(root).join("Contents/Resources"))
            );
        }
        assert_eq!(
            bundle_resources(Path::new("/tmp/target/release/ade-client")),
            None
        );
    }
}
