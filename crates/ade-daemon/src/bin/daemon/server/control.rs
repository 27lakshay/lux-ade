//! The control lane (R004; architecture section 4: "Reserve capacity for
//! cancellation, health, settlement and shutdown"). The profile daemon listens
//! on a second owner-only socket beside its owner socket, with its own accept
//! thread and listen backlog. It serves only the operations that stop or
//! inspect existing work, so a flood of ordinary commands that fills the owner
//! socket's backlog cannot refuse a cancel. A connection is authenticated
//! exactly as on the owner socket; any other operation is refused before
//! admission. `@ade/client` derives the same path with `controlSocketPath`.
use super::*;
use std::os::unix::net::UnixListener;

/// The operations the control lane serves: `hello` and the health reads,
/// cancellation and stops of existing work, and shutdown (the restart handoff).
pub(super) const CONTROL_OPERATIONS: &[&str] = &[
    "hello",
    "runtime.status",
    "diagnostics.status",
    "agent.cancel",
    "agent.terminate",
    "terminal.stop",
    "service.stop",
    "runtime.prepare_restart",
];

pub(super) fn is_control_operation(op: &str) -> bool {
    CONTROL_OPERATIONS.contains(&op)
}

/// `/x/ade.sock` becomes `/x/ade.control.sock`; a path without `.sock` gains `.control`.
pub(super) fn control_socket(socket: &Path) -> PathBuf {
    let text = socket.to_string_lossy();
    match text.strip_suffix(".sock") {
        Some(stem) => PathBuf::from(format!("{stem}.control.sock")),
        None => PathBuf::from(format!("{text}.control")),
    }
}

/// The refusal for an operation outside the allowlist. Nothing was admitted.
pub(super) fn refusal(op: &str) -> Value {
    json!({
        "type": "error",
        "code": "invalid_request",
        "message": format!("{op} is not served on the control lane; use the profile socket"),
        "pre_admission_rejected": true,
    })
}

/// Opens the control lane. A daemon that cannot open it still serves its
/// owner socket; clients then fall back to that socket.
pub(super) fn start(host: &Arc<Host>) -> Option<runtime::SocketGuard> {
    let path = control_socket(&host.socket);
    match runtime::SocketGuard::bind(&path) {
        Ok((listener, guard)) => {
            let host = host.clone();
            std::thread::spawn(move || accept(listener, host));
            Some(guard)
        }
        Err(error) => {
            eprintln!(
                "The control lane {} could not be opened; clients use the profile socket: {error:#}",
                path.display()
            );
            None
        }
    }
}

fn accept(listener: UnixListener, host: Arc<Host>) {
    for stream in listener.incoming() {
        if host.stopping.load(Ordering::Acquire) {
            return;
        }
        let Ok(stream) = stream else { continue };
        // Only the profile's user may command it (F083), on this lane too.
        if let Err(error) = runtime::authenticate_peer(&stream, "ADE_E2E_DAEMON_PEER_UID_FILE") {
            runtime::refuse_peer(
                stream,
                json!({"type":"error","code":"unauthenticated","message":error.to_string()}),
            );
            continue;
        }
        let host = host.clone();
        std::thread::spawn(move || {
            let mut errors = stream.try_clone().ok();
            if let Err(error) = handle_connection(stream, host, Lane::Control)
                && let Some(stream) = errors.as_mut()
            {
                let _ = writeln!(stream, "{}", error_response(error));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_control_socket_sits_beside_the_owner_socket() {
        assert_eq!(
            control_socket(Path::new("/tmp/ade-501-abc.sock")),
            PathBuf::from("/tmp/ade-501-abc.control.sock")
        );
        assert_eq!(
            control_socket(Path::new("/tmp/d")),
            PathBuf::from("/tmp/d.control")
        );
    }

    #[test]
    fn only_stop_health_and_shutdown_operations_use_the_control_lane() {
        for op in [
            "hello",
            "agent.cancel",
            "terminal.stop",
            "service.stop",
            "runtime.prepare_restart",
        ] {
            assert!(is_control_operation(op), "{op}");
        }
        for op in [
            "agent.send",
            "conversation.get",
            "conversation.steer",
            "session.subscribe",
            "terminal.create",
            "service.start",
            "",
        ] {
            assert!(!is_control_operation(op), "{op}");
        }
        assert_eq!(refusal("agent.send")["pre_admission_rejected"], true);
    }
}
