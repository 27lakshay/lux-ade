//! Advisory local TCP listener observation. This does not reserve a port or prove
//! that the process list is complete for the current user.
use anyhow::{Context, Result, bail};
use std::{
    collections::HashSet,
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Listener {
    pub pid: u32,
    pub address: String,
    pub port: u16,
}

#[cfg(target_os = "macos")]
pub fn observe() -> Result<Vec<Listener>> {
    // lsof's documented field output is parseable without column-width or
    // localized-header assumptions. A timeout and byte limit bound this read.
    let mut child = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-w", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Cannot inspect local TCP listeners")?;
    let stdout = child.stdout.take().context("Listener output unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("Listener diagnostics unavailable")?;
    let output_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(1_048_577).read_to_end(&mut bytes)?;
        Ok::<Vec<u8>, std::io::Error>(bytes)
    });
    let error_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.take(65_537).read_to_end(&mut bytes)?;
        Ok::<Vec<u8>, std::io::Error>(bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output_reader.join();
            let _ = error_reader.join();
            bail!("Local listener inspection timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let bytes = output_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Listener reader failed"))??;
    let diagnostics = error_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Listener diagnostics reader failed"))??;
    if bytes.len() > 1_048_576 {
        bail!("Local listener inventory exceeds the supported limit");
    }
    if diagnostics.len() > 65_536 {
        bail!("Local listener diagnostics exceed the supported limit");
    }
    // lsof uses exit status 1 when it finds no matching open files. It also
    // uses nonzero status for inspection failures, which must not look empty.
    if !status.success()
        && !(status.code() == Some(1) && bytes.is_empty() && diagnostics.is_empty())
    {
        let detail = String::from_utf8_lossy(&diagnostics);
        bail!("Local listener inspection failed: {}", detail.trim());
    }
    let output = String::from_utf8(bytes).context("Invalid local listener output")?;
    let mut pid = None;
    let mut listeners = HashSet::new();
    for line in output.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
        } else if let (Some(process), Some(value)) = (pid, line.strip_prefix('n')) {
            let Some((address, port)) = value.rsplit_once(':') else {
                continue;
            };
            let Ok(port) = port.parse::<u16>() else {
                continue;
            };
            listeners.insert(Listener {
                pid: process,
                address: address.to_owned(),
                port,
            });
            if listeners.len() > 4096 {
                bail!("Local listener inventory exceeds the supported limit");
            }
        }
    }
    let mut listeners = listeners.into_iter().collect::<Vec<_>>();
    listeners.sort_by(|a, b| (a.port, &a.address, a.pid).cmp(&(b.port, &b.address, b.pid)));
    Ok(listeners)
}

#[cfg(not(target_os = "macos"))]
pub fn observe() -> Result<Vec<Listener>> {
    bail!("Local TCP listener inspection is not available on this host")
}
