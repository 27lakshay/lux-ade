use std::{env, path::PathBuf};
fn main() {
    if env::var_os("CARGO_FEATURE_NATIVE_TERMINAL").is_none() {
        return;
    }
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    println!("cargo:rerun-if-changed=src/terminal_state.c");
    let vt = root.join(".ade/native/vt/lib/libghostty-vt.a");
    println!("cargo:rerun-if-changed={}", vt.display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join(".ade/vendor/libghostty-vt/include").display()
    );
    assert!(vt.is_file(), "Missing libghostty-vt: {}", vt.display());
    cc::Build::new()
        .file(
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("src/terminal_state.c"),
        )
        .include(root.join(".ade/vendor/libghostty-vt/include"))
        .compile("ade_terminal_state");
    println!(
        "cargo:rustc-link-arg-bin=ade-runtime={}",
        vt.canonicalize().unwrap().display()
    );
    println!("cargo:rustc-link-lib=c++");
}
