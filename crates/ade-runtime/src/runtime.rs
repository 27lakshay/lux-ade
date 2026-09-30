//! Control plane for the persistent terminal supervisor. Terminal bytes use a raw
//! socket relay; only control messages are decoded by the application daemon.
use ade_core::runtime_protocol::{
    AgentOp, AgentRequest, Connect, Control, Handoff, Hello, OWNER_FENCED, Owner, OwnerClaim,
    TerminalConnect,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
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
pub const PROTOCOL: &str = ade_core::runtime_protocol::VERSION;
pub const APPLICATION_PROTOCOL: &str = ade_core::protocol::APPLICATION_PROTOCOL;
// A complete appearance projection carries a 256-color palette per terminal.
// Use the application's bounded message budget for both control requests and replies.
pub const MAX_CONTROL: u64 = ade_core::protocol::MAX_MESSAGE_BYTES;

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

/// The user ID of the process on the other end of a Unix socket, or `None`
/// when the kernel will not say.
pub fn peer_uid(stream: &UnixStream) -> Option<libc::uid_t> {
    #[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd"))]
    {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        (unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
    }
    #[cfg(target_os = "linux")]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        (unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        } == 0)
            .then_some(credentials.uid)
    }
}

/// Whether a peer may use a profile socket: only the profile's own user.
/// An unknown identity is refused.
pub fn peer_authorized(peer: Option<libc::uid_t>, owner: libc::uid_t) -> bool {
    peer == Some(owner)
}

/// The user a profile socket admits: this process's effective user. Debug
/// builds let an E2E test name another user through a file that `variable`
/// points at, so a refusal can be observed without a second account.
pub fn socket_owner(variable: &str) -> libc::uid_t {
    if cfg!(debug_assertions)
        && let Some(path) = std::env::var_os(variable)
        && let Ok(text) = std::fs::read_to_string(path)
        && let Ok(uid) = text.trim().parse()
    {
        return uid;
    }
    unsafe { libc::geteuid() }
}

/// Authenticates an accepted connection. The socket file is owner-only, so
/// this is a second check: it also covers a socket whose mode was loosened
/// and the moment between `bind` and `chmod`.
pub fn authenticate_peer(stream: &UnixStream, variable: &str) -> Result<()> {
    ensure!(
        peer_authorized(peer_uid(stream), socket_owner(variable)),
        "unauthenticated: the peer is not the profile's user"
    );
    Ok(())
}

/// Answers an unauthenticated peer with one refusal line and closes. Its
/// request is discarded unread, for at most a second and 128 KiB, so the peer
/// can finish writing and read the refusal instead of a broken pipe.
pub fn refuse_peer(mut stream: UnixStream, refusal: Value) {
    std::thread::spawn(move || {
        let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
        let _ = writeln!(stream, "{refusal}");
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
        let _ = std::io::copy(&mut (&stream).take(MAX_CONTROL), &mut std::io::sink());
    });
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

pub fn request(socket: &Path, request: &Connect) -> Result<Value> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    write_frame(&mut stream, &serde_json::to_value(request)?)?;
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
    owner: Mutex<OwnerChannel>,
    handoff_path: PathBuf,
}
/// The owner's control connection. The runtime answers each command with
/// exactly one frame, in order, even after the daemon stopped waiting. The
/// channel counts replies it has not read, so a late reply is discarded and
/// never mistaken for the reply to a later command.
pub(crate) struct OwnerChannel {
    stream: UnixStream,
    /// Bytes read past the last complete frame, kept across read timeouts.
    partial: Vec<u8>,
    /// Commands sent whose reply has not been read yet.
    unanswered: usize,
    /// Set when framing can no longer be trusted; nothing is sent after it.
    broken: Option<String>,
}
/// What a failed read or write means for the channel's framing.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ChannelFault {
    /// The reply has not arrived yet; it is still owed and read later.
    Late,
    /// The byte stream is no longer aligned to frames.
    Broken,
}
pub(crate) fn channel_fault(error: &std::io::Error) -> ChannelFault {
    match error.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => ChannelFault::Late,
        _ => ChannelFault::Broken,
    }
}
impl OwnerChannel {
    pub(crate) fn new(reader: BufReader<UnixStream>) -> Self {
        let partial = reader.buffer().to_vec();
        Self {
            stream: reader.into_inner(),
            partial,
            unanswered: 0,
            broken: None,
        }
    }
    fn read_line(&mut self) -> std::io::Result<Vec<u8>> {
        loop {
            if let Some(end) = self.partial.iter().position(|b| *b == b'\n') {
                return Ok(self.partial.drain(..=end).collect());
            }
            if self.partial.len() as u64 >= MAX_CONTROL {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Runtime control frame too large",
                ));
            }
            let mut buffer = [0u8; 8192];
            match self.stream.read(&mut buffer) {
                Ok(0) => return Err(std::io::ErrorKind::UnexpectedEof.into()),
                Ok(n) => self.partial.extend_from_slice(&buffer[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
    }
    /// Reads the next owed reply, keeping the count of owed replies exact.
    fn next_reply(&mut self) -> Result<Vec<u8>> {
        match self.read_line() {
            Ok(line) => {
                self.unanswered -= 1;
                Ok(line)
            }
            Err(error) => {
                if channel_fault(&error) == ChannelFault::Broken {
                    self.broken = Some(error.to_string());
                }
                Err(error.into())
            }
        }
    }
    fn command(&mut self, value: &Value) -> Result<Value> {
        if let Some(reason) = &self.broken {
            bail!("Runtime control connection failed ({reason}); the command was not sent");
        }
        // Discard replies to earlier commands whose caller stopped waiting.
        while self.unanswered > 0 {
            self.next_reply().context(
                "An earlier runtime command is still unanswered; the command was not sent",
            )?;
        }
        let line = serde_json::to_string(value)?;
        ensure!(
            line.len() < MAX_CONTROL as usize,
            "Runtime control frame too large"
        );
        if let Err(error) = writeln!(self.stream, "{line}") {
            // A partial write misaligns the stream, and the runtime may still
            // have received the command, so its outcome is unknown.
            self.broken = Some(error.to_string());
            return Err(error.into());
        }
        self.unanswered = 1;
        let line = self.next_reply()?;
        let value: Value = serde_json::from_slice(&line)?;
        ensure!(
            value["type"] != "error",
            "{}",
            value["message"].as_str().unwrap_or("Runtime error")
        );
        Ok(value)
    }
}
impl Supervisor {
    pub fn data_directory(&self) -> &Path {
        self.handoff_path
            .parent()
            .expect("runtime handoff path has a parent")
    }
    pub fn connect(directory: &Path) -> Result<Self> {
        let socket = socket_path(directory);
        let hello = match UnixStream::connect(&socket) {
            Ok(_) => request(&socket, &Connect::Hello)?,
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
                    if let Ok(value) = request(&socket, &Connect::Hello) {
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
        let hello = Hello::accept(&hello, directory.to_str())?;
        let instance = hello.instance_id;
        let handoff_path = directory.join("runtime-handoff.json");
        let ticket = match std::fs::read(&handoff_path) {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes)
                    .context("Invalid runtime handoff record; preserve it for recovery")?;
                Handoff::ticket_for(&value, &instance, crate::model::now_ms())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let token = uuid::Uuid::new_v4().to_string();
        let mut stream = UnixStream::connect(&socket)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let claim = Connect::Claim(OwnerClaim {
            token: token.clone(),
            ticket,
            instance_id: instance.clone(),
            runtime_protocol: PROTOCOL.into(),
        });
        write_frame(&mut stream, &serde_json::to_value(claim)?)?;
        let mut reader = BufReader::new(stream);
        response(&mut reader)?;
        // A successful claim consumes the ticket. A later startup never replays it.
        if handoff_path.exists() {
            std::fs::remove_file(&handoff_path)?;
        }
        Ok(Self {
            socket,
            instance,
            pid: hello.pid,
            token,
            draining: AtomicBool::new(false),
            owner: Mutex::new(OwnerChannel::new(reader)),
            handoff_path,
        })
    }
    /// Sends one command on the owner's control socket and returns its reply.
    pub fn command(&self, command: impl Into<Control>) -> Result<Value> {
        let value = command.into().to_value();
        self.owner.lock().unwrap().command(&value)
    }
    pub fn prepare_handoff(&self) -> Result<Value> {
        self.draining.store(true, Ordering::Release);
        let ticket = match self.command(Owner::Prepare) {
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
            // Persist only a well-formed ticket; anything else aborts the handoff.
            let _: Handoff = serde_json::from_value(ticket.clone())
                .context("Runtime returned an invalid handoff ticket")?;
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
            let _ = self.command(Owner::Abort);
            self.draining.store(false, Ordering::Release);
        }
        result?;
        Ok(ticket)
    }
    pub fn draining(&self) -> bool {
        self.draining.load(Ordering::Acquire)
    }
    pub fn gone(&self) -> bool {
        if let Ok(hello) = request(&self.socket, &Connect::Hello) {
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
    /// Sends one `agent.*` request on its own connection with the owner token.
    pub fn agent(&self, op: AgentOp) -> Result<Value> {
        let request = serde_json::to_value(AgentRequest {
            token: self.token.clone(),
            op,
        })?;
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
            if value["code"] == OWNER_FENCED {
                // No receipt or external effect was admitted. Only a successful
                // check on our original control socket permits retry after abort.
                while self.draining() {
                    std::thread::sleep(Duration::from_millis(25));
                }
                self.command(Owner::Check)?;
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
        let connect = Connect::TerminalConnect(TerminalConnect {
            token: self.token.clone(),
            workspace_id: workspace_id.into(),
        });
        write_frame(&mut stream, &serde_json::to_value(connect)?)?;
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
            .stream
            .shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_profile_user_is_authorized() {
        assert!(peer_authorized(Some(501), 501));
        assert!(!peer_authorized(Some(502), 501));
        assert!(!peer_authorized(Some(0), 501));
        assert!(!peer_authorized(None, 501));
    }

    use super::*;
    use serde_json::json;
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
                owner: Mutex::new(OwnerChannel::new(BufReader::new(owner))),
                handoff_path: PathBuf::new(),
            };
            let result = supervisor.agent(AgentOp::Command {
                run: "fixture".into(),
                command: json!({"method":"send","key":"same-submission"}),
            });
            assert_eq!(result.is_ok(), still_owner);
            control_thread.join().unwrap();
            command_thread.join().unwrap();
        }
    }
    #[test]
    fn late_control_reply_is_discarded_not_read_as_the_next_reply() {
        let (client, mut runtime) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut channel = OwnerChannel::new(BufReader::new(client));
        let (released_tx, released_rx) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let mut reader = BufReader::new(runtime.try_clone().unwrap());
            let first = read_frame(&mut reader).unwrap();
            assert_eq!(first["op"], "terminal.list");
            // The runtime was blocked past the daemon's read timeout.
            released_rx.recv().unwrap();
            write_frame(&mut runtime, &json!({"type":"terminals","terminals":[]})).unwrap();
            let second = read_frame(&mut reader).unwrap();
            assert_eq!(second["op"], "terminal.stop");
            write_frame(
                &mut runtime,
                &json!({"type":"error","message":"still running"}),
            )
            .unwrap();
        });
        let error = channel.command(&json!({"op":"terminal.list"})).unwrap_err();
        let io = error.downcast_ref::<std::io::Error>().unwrap();
        assert_eq!(channel_fault(io), ChannelFault::Late);
        // While the earlier reply is still owed, a new command is not sent.
        assert!(channel.command(&json!({"op":"terminal.stop"})).is_err());
        assert_eq!(channel.unanswered, 1);
        released_tx.send(()).unwrap();
        // The late `terminals` list is discarded; the stop's own refusal wins.
        let error = channel.command(&json!({"op":"terminal.stop"})).unwrap_err();
        assert_eq!(error.to_string(), "still running");
        assert_eq!(channel.unanswered, 0);
        server.join().unwrap();
    }
    #[test]
    fn a_frame_split_across_a_timeout_is_kept_whole() {
        let (client, mut runtime) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        let mut channel = OwnerChannel::new(BufReader::new(client));
        runtime.write_all(b"{\"type\":\"a").unwrap();
        channel.unanswered = 1;
        assert!(channel.next_reply().is_err());
        assert!(channel.broken.is_none());
        runtime.write_all(b"ck\"}\n").unwrap();
        assert_eq!(channel.next_reply().unwrap(), b"{\"type\":\"ack\"}\n");
        drop(runtime);
        channel.unanswered = 1;
        assert!(channel.next_reply().is_err());
        assert!(channel.broken.is_some());
        assert!(channel.command(&json!({"op":"owner.check"})).is_err());
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
