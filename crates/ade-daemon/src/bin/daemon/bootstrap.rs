use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) fn run() -> anyhow::Result<()> {
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
    let _diagnostics_guard = ade_platform::diagnostics::init(&logs, "daemon")
        .map_err(|error| {
            eprintln!("Local diagnostics unavailable: {error}");
        })
        .ok();

    if std::env::args().nth(1).as_deref() == Some("--worktree-worker") {
        return ade_daemon::worktrees::worker_main();
    }
    if ade_daemon::bench::enabled() {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                ade_daemon::bench::flush();
            }
        });
    }
    let socket = std::env::var("ADE_SOCKET")
        .unwrap_or_else(|_| format!("/tmp/lux-ade-v4-{}.sock", unsafe { libc::getuid() }));
    let directory = std::env::var_os("ADE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&socket).with_extension("data"));
    super::server::serve(socket, directory)
}
