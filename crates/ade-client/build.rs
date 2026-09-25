//! The client library owns renderer linkage, including its interaction tests.
//! Keep this out of ade-platform: workspace feature unification would otherwise
//! propagate the renderer into daemon/runtime consumers of that shared crate.
use std::{env, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-env-changed=GHOSTTY_KIT_DIR");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let kit = env::var_os("GHOSTTY_KIT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root.join(".ade/native/ghostty/macos/GhosttyKit.xcframework/macos-arm64")
        });
    let archive = kit.join("libghostty-internal.a");
    println!("cargo:rerun-if-changed={}", archive.display());
    let bridge =
        PathBuf::from(env::var("DEP_ADE_PLATFORM_NATIVE_BRIDGE").expect("native bridge metadata"));
    let archive = archive
        .canonicalize()
        .expect("Ghostty renderer; run scripts/bootstrap.py");
    println!(
        "cargo:rustc-link-search=native={}",
        bridge.parent().unwrap().display()
    );
    println!(
        "cargo:rustc-link-search=native={}",
        archive.parent().unwrap().display()
    );
    println!("cargo:rustc-link-lib=static=ade_native_terminal");
    println!("cargo:rustc-link-lib=static=ghostty-internal");
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rustc-link-lib=z");
    for framework in [
        "Cocoa",
        "Foundation",
        "Carbon",
        "Metal",
        "QuartzCore",
        "CoreText",
        "CoreGraphics",
        "CoreFoundation",
        "Security",
        "ApplicationServices",
        "IOKit",
        "IOSurface",
        "UniformTypeIdentifiers",
        "UserNotifications",
        "CoreVideo",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
