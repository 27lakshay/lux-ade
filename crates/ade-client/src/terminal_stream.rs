//! Bounded, ordered terminal output. Dropping a window closes its socket and queue.
use async_channel::{Receiver, bounded};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Only startup has a deadline. Once restored, an idle terminal can stay silent
/// indefinitely; pane destruction shuts down its socket instead.
struct StartupReader {
    stream: UnixStream,
    deadline: Option<Instant>,
}
impl Read for StartupReader {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        ade_platform::ipc::read_until(&mut self.stream, bytes, self.deadline)
    }
}

#[derive(Debug)]
pub enum Event {
    Restore(Vec<u8>),
    Output(Vec<u8>),
    Resize(u16, u16),
    Failed(String),
}
pub struct Stream {
    pub events: Receiver<Event>,
    socket: Arc<Mutex<Option<UnixStream>>>,
}
fn bytes(value: &Value) -> anyhow::Result<Vec<u8>> {
    value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing terminal bytes"))?
        .iter()
        .map(|v| {
            v.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or_else(|| anyhow::anyhow!("Invalid terminal byte"))
        })
        .collect()
}
impl Stream {
    pub fn connect_terminal(
        endpoint: String,
        workspace: Option<&str>,
        terminal: Option<&str>,
    ) -> Self {
        Self::connect_with_timeout(endpoint, workspace, terminal, Duration::from_secs(5))
    }
    fn connect_with_timeout(
        endpoint: String,
        workspace: Option<&str>,
        terminal: Option<&str>,
        timeout: Duration,
    ) -> Self {
        let terminal = terminal.map(str::to_owned);
        let workspace = workspace.map(str::to_owned);
        let (sender, events) = bounded(16);
        let socket = Arc::new(Mutex::new(None));
        let shared = socket.clone();
        std::thread::spawn(move || {
            let result = (|| -> anyhow::Result<()> {
                let deadline = Instant::now() + timeout;
                if sender.is_closed() {
                    return Ok(());
                }
                let mut stream =
                    ade_platform::ipc::connect(std::path::Path::new(&endpoint), deadline)?;
                stream.set_write_timeout(Some(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .max(Duration::from_millis(1)),
                ))?;
                let mut owner = shared.lock().unwrap();
                if sender.is_closed() {
                    return Ok(());
                }
                *owner = Some(stream.try_clone()?);
                drop(owner);
                writeln!(
                    stream,
                    "{}",
                    json!({"op":"subscribe","snapshot_format":"binary","snapshot_encoding":"base64","workspace_id":workspace,"terminal_id":terminal})
                )?;
                let mut reader = BufReader::new(StartupReader {
                    stream,
                    deadline: Some(deadline),
                });
                let mut offset = None;
                loop {
                    let mut line = String::new();
                    let count = reader
                        .by_ref()
                        .take(crate::protocol::MAX_MESSAGE_BYTES)
                        .read_line(&mut line)?;
                    anyhow::ensure!(count != 0, "Terminal stream disconnected");
                    anyhow::ensure!(line.ends_with('\n'), "Terminal message exceeds 32 MiB");
                    let event: Value = serde_json::from_str(&line)?;
                    let output = match event["type"].as_str() {
                        Some("snapshot") => {
                            anyhow::ensure!(
                                offset.is_none(),
                                "Unexpected second terminal snapshot"
                            );
                            anyhow::ensure!(
                                event["terminal_snapshot_format"]
                                    == "ghostty-snapshot-v1-herdr-9c96f7d",
                                "Daemon does not support this native snapshot version; restart it after preserving your work"
                            );
                            anyhow::ensure!(
                                event["response_owner"] == "daemon-v1",
                                "Daemon does not own terminal responses; use the matching daemon build"
                            );
                            offset = event["metrics"]["terminal_bytes"].as_u64();
                            anyhow::ensure!(offset.is_some(), "Missing snapshot output offset");
                            {
                                let snapshot = crate::protocol::decode_snapshot(&event)?;
                                crate::protocol::check_snapshot_size(snapshot.len())
                                    .map_err(anyhow::Error::msg)?;
                                reader.get_mut().deadline = None;
                                Event::Restore(snapshot)
                            }
                        }
                        Some("terminal") => {
                            let chunk = bytes(&event["bytes"])?;
                            anyhow::ensure!(
                                offset.is_some() && event["offset"].as_u64() == offset,
                                "Gap in terminal output; reconnect required"
                            );
                            offset = offset.and_then(|n| n.checked_add(chunk.len() as u64));
                            anyhow::ensure!(offset.is_some(), "Terminal output offset overflow");
                            Event::Output(chunk)
                        }
                        Some("terminal_resize") => {
                            anyhow::ensure!(
                                offset.is_some() && event["offset"].as_u64() == offset,
                                "Gap before terminal resize"
                            );
                            let dimension = |key: &str| -> anyhow::Result<u16> {
                                event[key]
                                    .as_u64()
                                    .filter(|n| (2..=1000).contains(n))
                                    .map(|n| n as u16)
                                    .ok_or_else(|| anyhow::anyhow!("Invalid terminal dimension"))
                            };
                            Event::Resize(dimension("cols")?, dimension("rows")?)
                        }
                        Some("error") => anyhow::bail!("{}", event["message"]),
                        _ => continue,
                    };
                    if sender.send_blocking(output).is_err() {
                        return Ok(());
                    }
                }
            })();
            if let Err(error) = result {
                let _ = sender.send_blocking(Event::Failed(error.to_string()));
            }
        });
        Self { events, socket }
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.events.close();
        if let Some(socket) = self.socket.lock().unwrap().take() {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn restored_reader_drains_buffered_output_after_peer_closes() {
        let (client, mut server) = UnixStream::pair().unwrap();
        server.write_all(b"last output").unwrap();
        drop(server);
        let mut reader = StartupReader {
            stream: client,
            deadline: None,
        };
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"last output");
    }

    #[test]
    fn restored_terminal_may_remain_idle_past_startup_deadline() {
        let endpoint =
            std::env::temp_dir().join(format!("ade-stream-idle-{}.sock", std::process::id()));
        let listener = UnixListener::bind(&endpoint).unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            writeln!(
                socket,
                "{}",
                json!({"type":"snapshot","response_owner":"daemon-v1",
                "terminal_snapshot_format":"ghostty-snapshot-v1-herdr-9c96f7d",
                "metrics":{"terminal_bytes":0},"terminal_snapshot_bytes":[1]})
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(150));
            writeln!(
                socket,
                "{}",
                json!({"type":"terminal","offset":0,"bytes":[65]})
            )
            .unwrap();
        });
        let stream = Stream::connect_with_timeout(
            endpoint.to_string_lossy().into_owned(),
            None,
            None,
            Duration::from_millis(100),
        );
        assert!(matches!(
            stream.events.recv_blocking().unwrap(),
            Event::Restore(_)
        ));
        let output = stream.events.recv_blocking().unwrap();
        assert!(
            matches!(&output, Event::Output(bytes) if bytes == &[65]),
            "unexpected idle-stream result: {output:?}"
        );
        drop(stream);
        worker.join().unwrap();
        std::fs::remove_file(endpoint).unwrap();
    }

    #[test]
    fn startup_deadline_bounds_slow_drip_and_owner_drop_sends_no_stop() {
        let endpoint =
            std::env::temp_dir().join(format!("ade-stream-deadline-{}.sock", std::process::id()));
        let listener = UnixListener::bind(&endpoint).unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&request).unwrap()["op"],
                "subscribe"
            );
            for _ in 0..10 {
                if socket.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let mut remaining = String::new();
            reader.read_to_string(&mut remaining).unwrap();
            assert!(
                remaining.is_empty(),
                "closing a pane must never send a terminal stop request"
            );
        });
        let start = Instant::now();
        let stream = Stream::connect_with_timeout(
            endpoint.to_string_lossy().into_owned(),
            None,
            None,
            Duration::from_millis(60),
        );
        assert!(matches!(
            stream.events.recv_blocking().unwrap(),
            Event::Failed(_)
        ));
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(stream);
        worker.join().unwrap();
        std::fs::remove_file(endpoint).unwrap();
    }

    #[test]
    fn gap_is_rejected_and_drop_closes_connection() {
        for compact in [false, true] {
            let endpoint =
                std::env::temp_dir().join(format!("ade-stream-{}.sock", std::process::id()));
            let listener = UnixListener::bind(&endpoint).unwrap();
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&request).unwrap()["snapshot_format"],
                    "binary"
                );
                assert_eq!(
                    serde_json::from_str::<Value>(&request).unwrap()["snapshot_encoding"],
                    "base64"
                );
                let mut snapshot = json!({"type":"snapshot","response_owner":"daemon-v1","terminal_snapshot_format":"ghostty-snapshot-v1-herdr-9c96f7d","metrics":{"terminal_bytes":20}});
                if compact {
                    snapshot["terminal_snapshot_base64"] = json!("AQID");
                } else {
                    snapshot["terminal_snapshot_bytes"] = json!([1, 2, 3]);
                }
                writeln!(socket, "{}", snapshot).unwrap();
                writeln!(
                    socket,
                    "{}",
                    json!({"type":"terminal","offset":21,"bytes":[65]})
                )
                .unwrap();
                let mut byte = [0];
                assert_eq!(reader.read(&mut byte).unwrap(), 0);
            });
            let stream =
                Stream::connect_terminal(endpoint.to_string_lossy().into_owned(), None, None);
            assert!(matches!(
                stream.events.recv_blocking().unwrap(),
                Event::Restore(_)
            ));
            match stream.events.recv_blocking().unwrap() {
                Event::Failed(error) => assert!(error.contains("Gap in terminal output")),
                _ => panic!("gap must never reach the renderer"),
            }
            drop(stream);
            worker.join().unwrap();
            std::fs::remove_file(endpoint).unwrap();
        }
    }
}
