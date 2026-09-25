use serde_json::{Value, json};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct RawTerminal(Option<libc::termios>);
impl RawTerminal {
    fn enter() -> io::Result<Self> {
        unsafe {
            let mut saved = std::mem::zeroed();
            if libc::tcgetattr(0, &mut saved) != 0 {
                return Ok(Self(None));
            }
            let mut raw = saved;
            libc::cfmakeraw(&mut raw);
            if libc::tcsetattr(0, libc::TCSANOW, &raw) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(Some(saved)))
        }
    }
}
impl Drop for RawTerminal {
    fn drop(&mut self) {
        if let Some(saved) = &self.0 {
            unsafe {
                libc::tcsetattr(0, libc::TCSANOW, saved);
            }
        }
    }
}
fn size() -> (u16, u16, u16, u16) {
    unsafe {
        let mut size: libc::winsize = std::mem::zeroed();
        if libc::ioctl(0, libc::TIOCGWINSZ, &mut size) == 0 && size.ws_col > 0 {
            (size.ws_col, size.ws_row, size.ws_xpixel, size.ws_ypixel)
        } else {
            (100, 30, 0, 0)
        }
    }
}
fn send(stream: &mut UnixStream, value: Value) -> io::Result<()> {
    writeln!(stream, "{value}")
}
pub(super) fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let workspace = if let Some(index) = args.iter().position(|arg| arg == "--workspace") {
        if index + 1 >= args.len() {
            return Err("--workspace requires an ID".into());
        }
        let id = args.remove(index + 1);
        args.remove(index);
        Some(id)
    } else {
        None
    };
    let terminal_id = if let Some(index) = args.iter().position(|arg| arg == "--terminal") {
        if index + 1 >= args.len() {
            return Err("--terminal requires an ID".into());
        }
        let id = args.remove(index + 1);
        args.remove(index);
        Some(id)
    } else {
        None
    };
    if args.is_empty() || args[0] == "--help" {
        println!(
            "ade-attach --snapshot | --snapshot-binary | --status | --simulate PROMPT | --send TEXT\nTerminal viewing uses the native lux-ade client, which suppresses duplicate replies.\n--input-only is the native client's internal keyboard/resize adapter. --workspace ID selects a workspace; --terminal ID selects one of its shells. ADE_SOCKET overrides the socket."
        );
        return Ok(());
    }
    let input_only = args.first().is_some_and(|arg| arg == "--input-only");
    let socket = std::env::var("ADE_SOCKET")
        .unwrap_or_else(|_| format!("/tmp/lux-ade-v4-{}.sock", unsafe { libc::getuid() }));
    let mut stream = UnixStream::connect(&socket)
        .map_err(|e| format!("Cannot connect to {socket}: {e}. Start ade-daemon first."))?;
    if let Some(mode) = args.first().filter(|_| !input_only) {
        let mut request = match mode.as_str() {
            "--snapshot" | "--status" => json!({"op":"snapshot"}),
            "--snapshot-binary" => json!({"op":"snapshot_binary"}),
            "--check-protocol" => json!({"op":"hello"}),
            "--simulate" => {
                json!({"op":"simulate","prompt":args.get(1).map(String::as_str).unwrap_or("Demonstrate the daemon")})
            }
            "--send" => json!({"op":"input","data":args.get(1).map(String::as_str).unwrap_or("")}),
            _ => return Err(format!("Unknown option: {mode}").into()),
        };
        if let Some(workspace) = &workspace {
            request["workspace_id"] = json!(workspace);
        }
        request["terminal_id"] = json!(terminal_id);
        send(&mut stream, request)?;
        if mode == "--send" {
            send(&mut stream, json!({"op":"ping"}))?;
        }
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line)?;
        if mode == "--check-protocol" {
            let response: Value = serde_json::from_str(&line)?;
            if response["application_protocol"] != ade_core::protocol::APPLICATION_PROTOCOL
                || response["review_protocol"] != "ade-review-v1"
                || response["worktree_protocol"] != "ade-worktrees-v1"
                || response["session_protocol"] != "ade-sessions-v1"
                || response["terminal_snapshot_format"] != "ghostty-snapshot-v1-herdr-9c96f7d"
                || response["response_owner"] != "daemon-v1"
            {
                return Err("Daemon snapshot protocol is incompatible. Preserve the existing shell and use a different ADE_SOCKET, or restart its daemon when that shell is no longer needed.".into());
            }
        }
        print!("{line}");
        return Ok(());
    }
    let _raw = RawTerminal::enter()?;
    send(
        &mut stream,
        json!({"op":"subscribe","terminal":!input_only,"workspace_id":workspace,"terminal_id":terminal_id}),
    )?;
    let (cols, rows, width, height) = size();
    send(
        &mut stream,
        json!({"op":"resize","cols":cols,"rows":rows,"width_px":width,"height_px":height,"claim":false}),
    )?;
    let reader = stream.try_clone()?;
    let writer = Arc::new(Mutex::new(stream));
    let input_writer = writer.clone();
    std::thread::spawn(move || {
        let mut input = io::stdin();
        let mut buffer = [0u8; 4096];
        loop {
            match input.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let (cols, rows, width, height) = size();
                    // Typing is an unambiguous active-view signal, unlike a
                    // background window's resize notification.
                    if send(
                        &mut input_writer.lock().unwrap(),
                        json!({"op":"resize","cols":cols,"rows":rows,"width_px":width,"height_px":height,"claim":true}),
                    )
                    .is_err()
                    {
                        break;
                    }
                    if let Some(at) = buffer[..n].iter().position(|b| *b == 0x1d) {
                        if at > 0 {
                            let _ = send(
                                &mut input_writer.lock().unwrap(),
                                json!({"op":"input","bytes":&buffer[..at]}),
                            );
                        }
                        break;
                    }
                    if send(
                        &mut input_writer.lock().unwrap(),
                        json!({"op":"input","bytes":&buffer[..n]}),
                    )
                    .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = input_writer
            .lock()
            .unwrap()
            .shutdown(std::net::Shutdown::Both);
    });
    std::thread::spawn(move || {
        let mut previous = (cols, rows, width, height);
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let current = size();
            if current != previous {
                previous = current;
                if send(
                    &mut writer.lock().unwrap(),
                    json!({"op":"resize","cols":current.0,"rows":current.1,"width_px":current.2,"height_px":current.3,"claim":false}),
                )
                .is_err()
                {
                    break;
                }
            }
        }
    });
    // Never relay VT output into the attach PTY: an outer terminal would reply
    // again. Native viewers receive snapshots/output on a separate connection.
    for line in BufReader::new(reader).lines() {
        let event: Value = serde_json::from_str(&line?)?;
        if event["type"] == "error" {
            return Err(event["message"].to_string().into());
        }
    }
    Ok(())
}
