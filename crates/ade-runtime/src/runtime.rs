//! Control plane for the persistent terminal supervisor. Terminal bytes use a raw
//! socket relay; only control messages are decoded by the application daemon.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

// v7 adds explicit, identity-checked terminal process launches.
pub const PROTOCOL: &str = "ade-runtime-v8";
pub const APPLICATION_PROTOCOL: &str = "ade-application-v1";
pub const MAX_CONTROL: u64 = 128 * 1024;

pub fn read_frame(reader: &mut BufReader<UnixStream>) -> Result<Value> {
    let mut line = String::new();
    reader.by_ref().take(MAX_CONTROL).read_line(&mut line)?;
    ensure!(
        line.ends_with('\n'),
        "Runtime disconnected or control frame too large"
    );
    Ok(serde_json::from_str(&line)?)
}
pub fn write_frame(stream: &mut UnixStream, value: &Value) -> Result<()> {
    let line = serde_json::to_string(value)?;
    ensure!(
        line.len() < MAX_CONTROL as usize,
        "Runtime control frame too large"
    );
    writeln!(stream, "{line}")?;
    Ok(())
}
pub fn socket_path(directory: &Path) -> PathBuf {
    if let Some(value) = std::env::var_os("ADE_RUNTIME_SOCKET") {
        return value.into();
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    directory.hash(&mut hash);
    // macOS Unix socket paths are limited to 104 bytes. Identity is also checked
    // in hello, so a hash collision cannot attach a different data directory.
    PathBuf::from(format!(
        "/tmp/ade-runtime-{}-{:016x}.sock",
        unsafe { libc::getuid() },
        hash.finish()
    ))
}
pub fn lock(directory: &Path, name: &str) -> Result<File> {
    std::fs::create_dir_all(directory)?;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(directory.join(name))?;
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "Another process owns {}",
        directory.join(name).display()
    );
    Ok(file)
}

pub struct SocketGuard {
    path: PathBuf,
    device: u64,
    inode: u64,
}
impl SocketGuard {
    pub fn bind(path: &Path) -> Result<(UnixListener, Self)> {
        if UnixStream::connect(path).is_ok() {
            bail!("A process is already listening at {}", path.display());
        }
        match std::fs::symlink_metadata(path) {
            Ok(meta) => {
                ensure!(
                    meta.file_type().is_socket() && meta.uid() == unsafe { libc::getuid() },
                    "Refusing to replace a non-socket or another user's endpoint: {}",
                    path.display()
                );
                std::fs::remove_file(path)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let meta = std::fs::symlink_metadata(path)?;
        Ok((
            listener,
            Self {
                path: path.into(),
                device: meta.dev(),
                inode: meta.ino(),
            },
        ))
    }
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Ok(meta) = std::fs::symlink_metadata(&self.path)
            && meta.dev() == self.device
            && meta.ino() == self.inode
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub fn request(socket: &Path, value: &Value) -> Result<Value> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    write_frame(&mut stream, value)?;
    response(&mut BufReader::new(stream))
}
fn response(reader: &mut BufReader<UnixStream>) -> Result<Value> {
    let value = read_frame(reader)?;
    ensure!(
        value["type"] != "error",
        "{}",
        value["message"].as_str().unwrap_or("Runtime error")
    );
    Ok(value)
}
#[derive(Debug)]
pub struct OwnerFenced;
impl std::fmt::Display for OwnerFenced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Agent command belongs to a stale or draining owner")
    }
}
impl std::error::Error for OwnerFenced {}
#[derive(Debug)]
pub struct Rejected(pub String);
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Rejected {}
fn agent_rejection(value: &Value) -> anyhow::Error {
    if let Ok(failure) = serde_json::from_value::<ade_core::error::Failure>(value["code"].clone()) {
        // Keep the rejection marker used for ownership and the safe typed cause.
        anyhow::Error::new(failure).context(Rejected(failure.to_string()))
    } else {
        Rejected(
            value["message"]
                .as_str()
                .unwrap_or("Agent runtime error")
                .into(),
        )
        .into()
    }
}
pub struct Supervisor {
    pub socket: PathBuf,
    pub instance: String,
    pub pid: u32,
    token: String,
    draining: AtomicBool,
    owner: Mutex<BufReader<UnixStream>>,
    handoff_path: PathBuf,
}
impl Supervisor {
    pub fn connect(directory: &Path) -> Result<Self> {
        let socket = socket_path(directory);
        let hello = match UnixStream::connect(&socket) {
            Ok(_) => request(&socket, &json!({"op":"hello"}))?,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                let executable = std::env::current_exe()?.with_file_name("ade-runtime");
                let log = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .mode(0o600)
                    .open(directory.join("runtime.log"))?;
                let mut command = Command::new(executable);
                command
                    .env("ADE_DATA_DIR", directory)
                    .env("ADE_RUNTIME_SOCKET", &socket)
                    .stdin(Stdio::null())
                    .stdout(log.try_clone()?)
                    .stderr(log);
                unsafe {
                    command.pre_exec(|| {
                        if libc::setsid() < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
                let mut child = command
                    .spawn()
                    .context("Could not start ade-runtime; build all binaries")?;
                let deadline = Instant::now() + Duration::from_secs(8);
                loop {
                    if let Ok(value) = request(&socket, &json!({"op":"hello"})) {
                        break value;
                    }
                    if let Some(exit) = child.try_wait()? {
                        bail!(
                            "Runtime exited ({exit}); see {}",
                            directory.join("runtime.log").display()
                        );
                    }
                    ensure!(
                        Instant::now() < deadline,
                        "Runtime did not become ready; inspect runtime.log"
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            Err(error) => return Err(error.into()),
        };
        ensure!(
            hello["runtime_protocol"] == PROTOCOL,
            "Incompatible runtime; existing terminals were preserved"
        );
        ensure!(
            hello["data_directory"].as_str() == directory.to_str(),
            "Runtime belongs to another data directory"
        );
        let instance = hello["instance_id"]
            .as_str()
            .context("Runtime omitted identity")?
            .to_owned();
        let handoff_path = directory.join("runtime-handoff.json");
        let ticket = match std::fs::read(&handoff_path) {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes)
                    .context("Invalid runtime handoff record; preserve it for recovery")?;
                if value["instance_id"] == instance
                    && value["expires_at"]
                        .as_i64()
                        .is_some_and(|t| t > crate::model::now_ms())
                {
                    value["ticket"].clone()
                } else {
                    Value::Null
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
            Err(e) => return Err(e.into()),
        };
        let token = uuid::Uuid::new_v4().to_string();
        let mut stream = UnixStream::connect(&socket)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        write_frame(
            &mut stream,
            &json!({"op":"owner.claim","token":token,"ticket":ticket,"instance_id":instance,"runtime_protocol":PROTOCOL}),
        )?;
        let mut reader = BufReader::new(stream);
        response(&mut reader)?;
        // A successful claim consumes the ticket. A later startup never replays it.
        if handoff_path.exists() {
            std::fs::remove_file(&handoff_path)?;
        }
        Ok(Self {
            socket,
            instance,
            pid: hello["pid"].as_u64().context("Runtime omitted PID")? as u32,
            token,
            draining: AtomicBool::new(false),
            owner: Mutex::new(reader),
            handoff_path,
        })
    }
    pub fn command(&self, value: Value) -> Result<Value> {
        let mut reader = self.owner.lock().unwrap();
        write_frame(reader.get_mut(), &value)?;
        response(&mut reader)
    }
    pub fn prepare_handoff(&self) -> Result<Value> {
        self.draining.store(true, Ordering::Release);
        let ticket = match self.command(json!({"op":"owner.prepare"})) {
            Ok(ticket) => ticket,
            Err(error) => {
                self.draining.store(false, Ordering::Release);
                return Err(error);
            }
        };
        let temporary = self
            .handoff_path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)?;
            serde_json::to_writer(&mut file, &ticket)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &self.handoff_path)?;
            File::open(self.handoff_path.parent().unwrap())?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temporary);
            let _ = self.command(json!({"op":"owner.abort"}));
            self.draining.store(false, Ordering::Release);
        }
        result?;
        Ok(ticket)
    }
    pub fn draining(&self) -> bool {
        self.draining.load(Ordering::Acquire)
    }
    pub fn gone(&self) -> bool {
        if let Ok(hello) = request(&self.socket, &json!({"op":"hello"})) {
            return hello["instance_id"] != self.instance;
        }
        // Reap our own child if it exited; a supervisor inherited from an earlier
        // daemon is reaped by the OS. Never infer process death from a socket timeout.
        let mut exit_status = 0;
        unsafe {
            libc::waitpid(self.pid as i32, &mut exit_status, libc::WNOHANG);
        }
        unsafe {
            libc::kill(self.pid as i32, 0) != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }
    pub fn agent(&self, mut request: Value) -> Result<Value> {
        request["token"] = json!(self.token);
        loop {
            while self.draining() {
                std::thread::sleep(Duration::from_millis(25));
            }
            let mut stream = UnixStream::connect(&self.socket)?;
            stream.set_read_timeout(Some(Duration::from_secs(60)))?;
            stream.set_write_timeout(Some(Duration::from_secs(5)))?;
            crate::agent_runtime::write(&mut stream, &request)?;
            let value = crate::agent_runtime::read(&mut BufReader::new(stream)).context(
                "Agent runtime connection failed. Restart lux-ade, then resume; no prompt was resent",
            )?;
            if value["code"] == "owner_fenced" {
                // No receipt or external effect was admitted. Only a successful
                // check on our original control socket permits retry after abort.
                while self.draining() {
                    std::thread::sleep(Duration::from_millis(25));
                }
                self.command(json!({"op":"owner.check"}))?;
                continue;
            }
            if value["type"] == "error" {
                return Err(agent_rejection(&value));
            }
            return Ok(value);
        }
    }
    pub fn terminal(&self, workspace_id: &str) -> Result<UnixStream> {
        let mut stream = UnixStream::connect(&self.socket)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        write_frame(
            &mut stream,
            &json!({"op":"terminal.connect","token":self.token,"workspace_id":workspace_id}),
        )?;
        // No terminal data is sent until the caller sends its first command.
        response(&mut BufReader::new(stream.try_clone()?))?;
        stream.set_read_timeout(None)?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        Ok(stream)
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self
            .owner
            .get_mut()
            .unwrap()
            .get_mut()
            .shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn draining_rejection_retries_same_command_only_after_owner_check() {
        for still_owner in [true, false] {
            let socket = PathBuf::from(format!("/tmp/ade-abort-test-{}", uuid::Uuid::new_v4()));
            let (listener, _guard) = SocketGuard::bind(&socket).unwrap();
            let (owner, mut control) = UnixStream::pair().unwrap();
            let control_thread = std::thread::spawn(move || {
                let request =
                    read_frame(&mut BufReader::new(control.try_clone().unwrap())).unwrap();
                assert_eq!(request["op"], "owner.check");
                write_frame(
                    &mut control,
                    &if still_owner {
                        json!({"type":"ack"})
                    } else {
                        json!({"type":"error","message":"Owner changed"})
                    },
                )
                .unwrap();
            });
            let command_thread = std::thread::spawn(move || {
                let (mut peer, _) = listener.accept().unwrap();
                let original =
                    crate::agent_runtime::read(&mut BufReader::new(peer.try_clone().unwrap()))
                        .unwrap();
                crate::agent_runtime::write(
                    &mut peer,
                    &json!({"type":"error","code":"owner_fenced","message":"draining"}),
                )
                .unwrap();
                if still_owner {
                    let (mut retry, _) = listener.accept().unwrap();
                    let repeated =
                        crate::agent_runtime::read(&mut BufReader::new(retry.try_clone().unwrap()))
                            .unwrap();
                    assert_eq!(original, repeated);
                    crate::agent_runtime::write(&mut retry, &json!({"type":"ack"})).unwrap();
                }
            });
            let supervisor = Supervisor {
                socket,
                instance: "fixture".into(),
                pid: std::process::id(),
                token: "fixture".into(),
                draining: AtomicBool::new(false),
                owner: Mutex::new(BufReader::new(owner)),
                handoff_path: PathBuf::new(),
            };
            let result = supervisor.agent(
                json!({"op":"agent.command","command":{"method":"send","key":"same-submission"}}),
            );
            assert_eq!(result.is_ok(), still_owner);
            control_thread.join().unwrap();
            command_thread.join().unwrap();
        }
    }
    #[test]
    fn endpoint_guard_never_removes_regular_files_or_a_replacement() {
        let path = PathBuf::from(format!("/tmp/ade-socket-test-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "preserve").unwrap();
        assert!(SocketGuard::bind(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "preserve");
        std::fs::remove_file(&path).unwrap();
        let (listener, guard) = SocketGuard::bind(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "replacement").unwrap();
        drop(guard);
        drop(listener);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "replacement");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn writer_lock_is_exclusive_and_reuses_the_original_inode() {
        let directory = PathBuf::from(format!("/tmp/ade-lock-test-{}", uuid::Uuid::new_v4()));
        let first = lock(&directory, "writer.lock").unwrap();
        let inode = first.metadata().unwrap().ino();
        assert!(lock(&directory, "writer.lock").is_err());
        drop(first);
        let next = lock(&directory, "writer.lock").unwrap();
        assert_eq!(next.metadata().unwrap().ino(), inode);
        drop(next);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    #[test]
    fn runtime_rejection_preserves_both_ownership_marker_and_failure_category() {
        let value =
            ade_core::error::error_envelope(ade_core::error::Failure::Authentication.into());
        let error = agent_rejection(&value);
        assert!(error.downcast_ref::<Rejected>().is_some());
        assert_eq!(
            error.downcast_ref::<ade_core::error::Failure>(),
            Some(&ade_core::error::Failure::Authentication)
        );
        assert_eq!(
            ade_core::error::error_envelope(error)["recovery"],
            "sign_in"
        );
    }
}
