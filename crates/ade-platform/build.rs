use std::{env, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-env-changed=GHOSTTY_KIT_DIR");
    println!("cargo:rerun-if-env-changed=GHOSTTY_RESOURCES_DIR");
    if env::var_os("CARGO_FEATURE_NATIVE_UI").is_none()
        || env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos")
    {
        return;
    }
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    println!(
        "cargo:rerun-if-changed={}",
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("native/terminal.m")
            .display()
    );
    println!("cargo:rerun-if-changed=native/accessibility.m");
    let work = root.join(".ade/native");
    let kit = env::var_os("GHOSTTY_KIT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| work.join("ghostty/macos/GhosttyKit.xcframework/macos-arm64"));
    let resources = env::var_os("GHOSTTY_RESOURCES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| work.join("install/share/ghostty"));
    let archive = kit.join("libghostty-internal.a");
    println!("cargo:rerun-if-changed={}", archive.display());
    println!(
        "cargo:rerun-if-changed={}",
        kit.join("Headers/ghostty.h").display()
    );
    assert!(
        archive.is_file(),
        "Missing GhosttyKit archive: {}. See native/README.md",
        archive.display()
    );
    assert!(
        resources.is_dir(),
        "Missing Ghostty runtime resources: {}",
        resources.display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        root.join("assets/terminal.conf").display()
    );
    let terminal_theme = format!("\"{}\"", root.join("assets/terminal.conf").display());
    cc::Build::new()
        .cargo_metadata(false)
        .define("ADE_TERMINAL_THEME_PATH", Some(terminal_theme.as_str()))
        .file(PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("native/terminal.m"))
        .file(
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
                .join("native/accessibility.m"),
        )
        .include(kit.join("Headers"))
        .flag("-fobjc-arc")
        .flag("-fblocks")
        .compile("ade_native_terminal");
    println!(
        "cargo:bridge={}",
        PathBuf::from(env::var_os("OUT_DIR").unwrap())
            .join("libade_native_terminal.a")
            .display()
    );
    println!(
        "cargo:rustc-env=ADE_GHOSTTY_RESOURCES={}",
        resources.canonicalize().unwrap().display()
    );
}
