use anyhow::{Context, Result};

pub(super) fn run() -> Result<()> {
    let logs = ade_platform::resources::logs();
    if let Some(destination) = std::env::args()
        .skip(1)
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == "--export-diagnostics")
        .map(|pair| pair[1].clone())
    {
        match ade_platform::diagnostics::export(&logs, std::path::Path::new(&destination)) {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("Diagnostic export failed: {error}");
                std::process::exit(1);
            }
        }
    }
    let _diagnostics_guard = ade_platform::diagnostics::init(&logs, "runtime")
        .map_err(|error| {
            eprintln!("Local diagnostics unavailable: {error}");
        })
        .ok();

    let directory = std::fs::canonicalize(
        std::env::var_os("ADE_DATA_DIR").context("ADE_DATA_DIR is required")?,
    )?;
    super::server::serve(directory)
}
