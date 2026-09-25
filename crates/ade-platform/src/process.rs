//! Bounded controller execution. Only the immediate child is ever signalled.
use anyhow::{Context, Result, bail};
use std::{
    io::Read,
    os::fd::AsRawFd,
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr_bytes: u64,
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            // No process-group signalling: a controller may have started the
            // persistent daemon. It remains owned by the runtime, not this helper.
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn nonblocking(pipe: &impl AsRawFd) -> Result<()> {
    let fd = pipe.as_raw_fd();
    // SAFETY: fd belongs to the live pipe and fcntl neither takes ownership nor
    // accesses Rust memory. Preserve all existing descriptor status flags.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}
fn drain(
    pipe: &mut impl Read,
    mut capture: Option<&mut Vec<u8>>,
    limit: usize,
    count: &mut u64,
) -> Result<()> {
    let mut buffer = [0u8; 4096];
    // Limit each pass so a continuously writing child cannot prevent deadline checks.
    for _ in 0..16 {
        match pipe.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(size) => {
                *count = count.saturating_add(size as u64);
                if let Some(output) = &mut capture {
                    if output.len().saturating_add(size) > limit {
                        bail!(
                            "Controller response exceeds the size limit; check runtime status before retrying"
                        );
                    }
                    output.extend_from_slice(&buffer[..size]);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
pub fn run(command: &mut Command, timeout: Duration, stdout_limit: usize) -> Result<Output> {
    let deadline = Instant::now() + timeout;
    let mut child = OwnedChild(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Could not launch lux-ade controller")?,
    );
    let mut stdout_pipe = child.0.stdout.take().context("Missing controller stdout")?;
    let mut stderr_pipe = child.0.stderr.take().context("Missing controller stderr")?;
    nonblocking(&stdout_pipe)?;
    nonblocking(&stderr_pipe)?;
    let mut stdout = Vec::new();
    let mut stdout_bytes = 0;
    let mut stderr_bytes = 0;
    loop {
        if Instant::now() >= deadline {
            bail!(
                "lux-ade controller exceeded its deadline. Check runtime status before retrying; a started daemon was left running"
            );
        }
        drain(
            &mut stdout_pipe,
            Some(&mut stdout),
            stdout_limit,
            &mut stdout_bytes,
        )?;
        drain(&mut stderr_pipe, None, 0, &mut stderr_bytes)?;
        if let Some(status) = child.0.try_wait()? {
            // The helper has exited. Drain its remaining bounded output, without
            // waiting for EOF from a descendant that inherited a pipe.
            loop {
                let before = stdout_bytes;
                drain(
                    &mut stdout_pipe,
                    Some(&mut stdout),
                    stdout_limit,
                    &mut stdout_bytes,
                )?;
                if stdout_bytes == before {
                    break;
                }
                if Instant::now() >= deadline {
                    bail!("Controller output did not finish before its deadline");
                }
            }
            drain(&mut stderr_pipe, None, 0, &mut stderr_bytes)?;
            return Ok(Output {
                status,
                stdout,
                stderr_bytes,
            });
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timeout_reaps_owned_helper_promptly() {
        let start = Instant::now();
        let error = run(
            Command::new("/bin/sleep").arg("10"),
            Duration::from_millis(40),
            1024,
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("deadline"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn stdout_is_bounded_and_stderr_is_not_retained() {
        let output = run(
            Command::new("/bin/sh").args(["-c", "printf '{}'; printf 'secret' >&2"]),
            Duration::from_secs(2),
            32,
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"{}");
        assert_eq!(output.stderr_bytes, 6);
        let error = run(
            Command::new("/bin/sh").args(["-c", "printf 'too much secret output'"]),
            Duration::from_secs(2),
            4,
        )
        .err()
        .unwrap();
        assert!(!error.to_string().contains("secret"));
    }
    #[test]
    fn timing_out_a_controller_leaves_its_started_child_alive() {
        let marker = std::env::temp_dir().join(format!(
            "ade-controller-child-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let result = run(
            Command::new("/bin/sh")
                .args([
                    "-c",
                    "(sleep 0.15; printf survived > \"$1\") & wait",
                    "ade-test",
                ])
                .arg(&marker),
            Duration::from_millis(40),
            32,
        );
        assert!(result.is_err());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !marker.exists() {
            assert!(
                Instant::now() < deadline,
                "helper timeout killed descendant"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "survived");
        std::fs::remove_file(marker).unwrap();
    }
    #[test]
    fn completed_helper_does_not_wait_for_inherited_descendant_pipes() {
        let output = run(
            Command::new("/bin/sh").args(["-c", "sleep 0.2 & printf '{}'"]),
            Duration::from_millis(100),
            32,
        )
        .unwrap();
        assert_eq!(output.stdout, b"{}");
    }
}
