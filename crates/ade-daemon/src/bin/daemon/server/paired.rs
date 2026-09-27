//! The paired endpoint (F121, F122; D13). A daemon that `ade-control`
//! started has a runtime home with a grant file. Once it holds a grant, the
//! daemon listens on a second owner-only socket beside its owner socket. A
//! connection there must open with a `hello` that presents an active
//! pairing's ID and token; after that it is served like any other connection.
//! Revocation refuses new connections at once, because every hello reads the
//! grant file, and a watcher closes the revoked pairing's open connections.
//! The decisions are in `ade_daemon::remote_access`.
use super::*;
use ade_daemon::remote_access::{self, Admission, Grants};
use std::os::unix::net::UnixListener;

const WATCH_INTERVAL: Duration = Duration::from_millis(100);
const MAX_HELLO: usize = 16 * 1024;

pub(super) struct Paired {
    grants_file: PathBuf,
    socket: PathBuf,
    state: Mutex<PairedState>,
}

#[derive(Default)]
struct PairedState {
    guard: Option<runtime::SocketGuard>,
    connections: HashMap<u64, (String, UnixStream)>,
    next: u64,
}

impl Paired {
    /// Opens the endpoint when the grant file has an active grant, and
    /// watches the file. Only a daemon with a runtime home has one.
    pub(super) fn start(host: &Arc<Host>) -> Option<Arc<Self>> {
        let home = std::env::var_os("ADE_RUNTIME_HOME")?;
        let paired = Arc::new(Self {
            grants_file: Path::new(&home).join(remote_access::GRANTS_FILE),
            socket: remote_access::paired_socket(&host.socket),
            state: Mutex::new(PairedState::default()),
        });
        paired.refresh(host);
        let watcher = paired.clone();
        let host = host.clone();
        std::thread::spawn(move || {
            while !host.stopping.load(Ordering::Acquire) {
                std::thread::sleep(WATCH_INTERVAL);
                watcher.refresh(&host);
            }
        });
        Some(paired)
    }

    /// Removes the endpoint when the daemon stops.
    pub(super) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.guard = None;
        for (_, (_, stream)) in state.connections.drain() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    fn grants(&self) -> Grants {
        match std::fs::read(&self.grants_file) {
            Ok(bytes) => Grants::parse(&bytes).unwrap_or_else(|error| {
                // An unreadable file grants nothing: fail closed.
                eprintln!(
                    "Access grants are unreadable; the paired endpoint admits no one: {error}"
                );
                Grants::default()
            }),
            Err(_) => Grants::default(),
        }
    }

    /// Opens the endpoint once a grant is active, and closes every open
    /// connection whose pairing is no longer active.
    fn refresh(self: &Arc<Self>, host: &Arc<Host>) {
        let grants = self.grants();
        let mut state = self.state.lock().unwrap();
        state.connections.retain(|_, (pairing_id, stream)| {
            let keep = grants.is_active(pairing_id);
            if !keep {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            keep
        });
        // Once the host has granted any pairing, the endpoint stays open, so a
        // revoked client gets a definite refusal rather than no listener.
        if state.guard.is_some() || grants.grants.is_empty() {
            return;
        }
        match runtime::SocketGuard::bind(&self.socket) {
            Ok((listener, guard)) => {
                state.guard = Some(guard);
                let paired = self.clone();
                let host = host.clone();
                std::thread::spawn(move || paired.accept(listener, host));
            }
            Err(error) => eprintln!(
                "The paired endpoint {} could not be opened: {error:#}",
                self.socket.display()
            ),
        }
    }

    fn accept(self: Arc<Self>, listener: UnixListener, host: Arc<Host>) {
        for stream in listener.incoming() {
            if host.stopping.load(Ordering::Acquire) {
                return;
            }
            let Ok(stream) = stream else { continue };
            if let Err(error) = runtime::authenticate_peer(&stream, "ADE_E2E_DAEMON_PEER_UID_FILE")
            {
                runtime::refuse_peer(
                    stream,
                    json!({"type":"error","code":"unauthenticated","message":error.to_string()}),
                );
                continue;
            }
            let paired = self.clone();
            let host = host.clone();
            std::thread::spawn(move || {
                let mut errors = stream.try_clone().ok();
                if let Err(error) = paired.serve(stream, host)
                    && let Some(stream) = errors.as_mut()
                {
                    let _ = writeln!(stream, "{}", error_response(error));
                }
            });
        }
    }

    fn serve(&self, mut stream: UnixStream, host: Arc<Host>) -> anyhow::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        let Some(line) = read_line_unbuffered(&mut stream)? else {
            return Ok(());
        };
        stream.set_read_timeout(None)?;
        let request: Value = serde_json::from_str(&line)?;
        let hello = (request["op"] == "hello")
            .then(|| decode::<HelloRequest>(&request).ok())
            .flatten();
        let admission = match &hello {
            Some(hello) => remote_access::admit(
                &self.grants(),
                hello.pairing_id.as_deref(),
                hello.pairing_token.as_deref(),
            ),
            None => Admission::Unauthenticated(
                "The first request on the paired endpoint must be hello with a pairing",
            ),
        };
        let pairing_id = match admission {
            Admission::Granted(pairing_id) => pairing_id,
            refused => {
                let (code, message) = remote_access::refusal(&refused).unwrap_or_default();
                writeln!(
                    stream,
                    "{}",
                    json!({"type":"error","code":code,"message":message})
                )?;
                let _ = stream.shutdown(std::net::Shutdown::Both);
                return Ok(());
            }
        };
        let id = {
            let mut state = self.state.lock().unwrap();
            state.next += 1;
            let id = state.next;
            state
                .connections
                .insert(id, (pairing_id, stream.try_clone()?));
            id
        };
        let result = writeln!(stream, "{}", host.hello())
            .map_err(anyhow::Error::from)
            .and_then(|()| handle_connection(stream, host, Lane::Owner));
        self.state.lock().unwrap().connections.remove(&id);
        result
    }
}

/// Reads the hello line one byte at a time, so nothing after it is taken
/// from the stream before the ordinary handler reads it.
fn read_line_unbuffered(stream: &mut UnixStream) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    let mut byte = [0u8];
    loop {
        if stream.read(&mut byte)? == 0 {
            return Ok(None);
        }
        if byte[0] == b'\n' {
            return String::from_utf8(line)
                .map(Some)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        }
        line.push(byte[0]);
        if line.len() > MAX_HELLO {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Hello too large",
            ));
        }
    }
}
