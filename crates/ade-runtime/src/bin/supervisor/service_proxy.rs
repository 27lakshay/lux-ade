//! Runtime-owned loopback addresses for managed services. A proxy survives a
//! daemon handoff; the daemon must re-verify the target for every connection.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream},
    os::unix::{fs::OpenOptionsExt, net::UnixStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

const MAX_HEADER: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 128;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
struct Key {
    workspace_id: String,
    service_name: String,
    port_variable: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    key: Key,
    port: u16,
    #[serde(default)]
    service_identity: String,
    #[serde(default)]
    target_port: u16,
    #[serde(default)]
    route_id: String,
    daemon_socket: PathBuf,
}

struct Route {
    record: Mutex<Record>,
    admission: RwLock<()>,
    retired: AtomicBool,
    listener: Mutex<Option<std::thread::JoinHandle<()>>>,
}

pub(super) struct Manager {
    file: PathBuf,
    records: Mutex<HashMap<Key, Arc<Route>>>,
    stop: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
}

impl Manager {
    pub(super) fn open(directory: &Path) -> Result<Self> {
        let file = directory.join("service-proxies.json");
        let mut saved: Vec<Record> = if file.exists() {
            serde_json::from_reader(File::open(&file)?)
                .context("Cannot read stable service proxy registry")?
        } else {
            Vec::new()
        };
        ensure!(saved.len() <= 256, "Too many stable service proxy routes");
        if saved.iter().any(|record| record.route_id.is_empty()) {
            for record in &mut saved {
                if record.route_id.is_empty() {
                    record.route_id = format!("route_{}", uuid::Uuid::new_v4());
                }
            }
            persist_values(&file, &saved)
                .context("Cannot backfill stable proxy route identities")?;
        }
        let manager = Self {
            file,
            records: Mutex::new(HashMap::new()),
            stop: Arc::new(AtomicBool::new(false)),
            connections: Arc::new(AtomicUsize::new(0)),
        };
        for record in saved {
            let key = record.key.clone();
            ensure!(
                !manager.records.lock().unwrap().contains_key(&key),
                "Duplicate stable service proxy route"
            );
            let route = Arc::new(Route {
                record: Mutex::new(record.clone()),
                admission: RwLock::new(()),
                retired: AtomicBool::new(false),
                listener: Mutex::new(None),
            });
            // A stolen port cannot be replaced by a new URL: fail runtime startup
            // so ADE never reports a stable address owned by another process.
            let listener = bind(Some(record.port)).with_context(|| {
                format!("Stable service proxy port {} is unavailable", record.port)
            })?;
            manager.spawn(listener, route.clone())?;
            manager.records.lock().unwrap().insert(key, route);
        }
        Ok(manager)
    }

    pub(super) fn ensure(
        &self,
        workspace_id: &str,
        service_name: &str,
        port_variable: &str,
        service_identity: &str,
        target_port: u16,
        remap: bool,
        expected_route_identity: &str,
        expected_route_port: u16,
        daemon_socket: &Path,
    ) -> Result<Value> {
        ensure!(
            daemon_socket.is_absolute(),
            "Daemon socket must be absolute"
        );
        ensure!(target_port != 0, "Service target port is unavailable");
        ensure!(
            !service_identity.is_empty(),
            "Service identity is unavailable"
        );
        let key = Key {
            workspace_id: workspace_id.to_owned(),
            service_name: service_name.to_owned(),
            port_variable: port_variable.to_owned(),
        };
        let mut records = self.records.lock().unwrap();
        if let Some(route) = records.get(&key) {
            let old = {
                let mut record = route.record.lock().unwrap();
                if remap {
                    ensure!(
                        record.service_identity == expected_route_identity
                            && record.target_port == expected_route_port,
                        "Stable service proxy route changed; inspect it again"
                    );
                }
                ensure!(
                    remap
                        || (record.target_port == target_port
                            && record.service_identity == service_identity),
                    "Service target changed; use service.proxy.remap"
                );
                let old = record.clone();
                record.daemon_socket = daemon_socket.to_path_buf();
                if remap {
                    record.target_port = target_port;
                    record.service_identity = service_identity.to_owned();
                }
                old
            };
            if let Err(error) = persist(&self.file, &records) {
                *route.record.lock().unwrap() = old;
                return Err(error);
            }
            return Ok(reply(&route.record.lock().unwrap()));
        }
        ensure!(!remap, "Stable service proxy route does not exist");
        ensure!(records.len() < 256, "Too many stable service proxy routes");
        let listener = bind(None)?;
        let port = listener.local_addr()?.port();
        let route = Arc::new(Route {
            record: Mutex::new(Record {
                key: key.clone(),
                port,
                service_identity: service_identity.to_owned(),
                target_port,
                route_id: format!("route_{}", uuid::Uuid::new_v4()),
                daemon_socket: daemon_socket.to_path_buf(),
            }),
            admission: RwLock::new(()),
            retired: AtomicBool::new(false),
            listener: Mutex::new(None),
        });
        records.insert(key.clone(), route.clone());
        if let Err(error) = persist(&self.file, &records) {
            records.remove(&key);
            return Err(error);
        }
        self.spawn(listener, route)?;
        Ok(reply(&records.get(&key).unwrap().record.lock().unwrap()))
    }

    pub(super) fn inspect(
        &self,
        workspace_id: &str,
        service_name: &str,
        port_variable: &str,
    ) -> Result<Value> {
        let key = Key {
            workspace_id: workspace_id.to_owned(),
            service_name: service_name.to_owned(),
            port_variable: port_variable.to_owned(),
        };
        let records = self.records.lock().unwrap();
        let route = records
            .get(&key)
            .context("Stable service proxy route does not exist")?;
        Ok(reply(&route.record.lock().unwrap()))
    }

    pub(super) fn retire(
        &self,
        workspace_id: &str,
        service_name: &str,
        port_variable: &str,
        expected_route_id: &str,
        expected_service_identity: &str,
        expected_target_port: u16,
        expected_proxy_port: u16,
    ) -> Result<Value> {
        ensure!(!expected_route_id.is_empty(), "Missing expected route ID");
        ensure!(
            !expected_service_identity.is_empty(),
            "Missing expected service identity"
        );
        ensure!(expected_target_port != 0, "Missing expected target port");
        ensure!(expected_proxy_port != 0, "Missing expected proxy port");
        let key = Key {
            workspace_id: workspace_id.to_owned(),
            service_name: service_name.to_owned(),
            port_variable: port_variable.to_owned(),
        };
        let mut records = self.records.lock().unwrap();
        let route = records
            .get(&key)
            .context("Stable service proxy route does not exist")?
            .clone();
        let snapshot = route.record.lock().unwrap().clone();
        ensure!(
            snapshot.route_id == expected_route_id
                && snapshot.service_identity == expected_service_identity
                && snapshot.target_port == expected_target_port
                && snapshot.port == expected_proxy_port,
            "Stable service proxy route changed; inspect it again"
        );
        // Fence requests that have been accepted but have not sent any bytes
        // upstream. Established HTTP/WebSocket streams have already passed this
        // gate and may drain against their original target.
        let _admission = route.admission.write().unwrap();
        let mut remaining = records.clone();
        remaining.remove(&key);
        if let Err(error) = persist(&self.file, &remaining) {
            // If rename succeeded but directory sync failed, restore the original
            // registry before returning. The live listener stays owned either way.
            let recovery = persist(&self.file, &records);
            return match recovery {
                Ok(()) => Err(error.context("Stable proxy retirement failed; route remains active")),
                Err(restore) => Err(error.context(format!(
                    "Stable proxy retirement failed; route remains active in this runtime, registry recovery is uncertain: {restore}"
                ))),
            };
        }
        route.retired.store(true, Ordering::Release);
        records.remove(&key);
        drop(records);
        if let Some(listener) = route.listener.lock().unwrap().take() {
            listener
                .join()
                .map_err(|_| anyhow::anyhow!("Stable proxy listener thread panicked"))?;
        }
        let mut result = reply(&snapshot);
        result["type"] = json!("service_proxy_retired");
        Ok(result)
    }

    pub(super) fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
    }

    fn spawn(&self, listener: TcpListener, route: Arc<Route>) -> Result<()> {
        listener.set_nonblocking(true)?;
        let stop = self.stop.clone();
        let connections = self.connections.clone();
        let active = route.clone();
        let handle = std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) && !active.retired.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut client, _)) => {
                        if active.retired.load(Ordering::Acquire) {
                            let _ = client.shutdown(Shutdown::Both);
                            break;
                        }
                        if client.set_nonblocking(false).is_err() {
                            continue;
                        }
                        if connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                            connections.fetch_sub(1, Ordering::AcqRel);
                            let _ = reject(&mut client, 503, "Service proxy is busy");
                            continue;
                        }
                        let route = active.clone();
                        let connections = connections.clone();
                        std::thread::spawn(move || {
                            let _ = handle(client, &route);
                            connections.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        });
        *route.listener.lock().unwrap() = Some(handle);
        Ok(())
    }
}

fn reply(record: &Record) -> Value {
    json!({"type":"service_proxy","url":format!("http://127.0.0.1:{}/", record.port),
        "port":record.port,"scope":"local_private","owner":"runtime",
        "service_identity":record.service_identity,"target_port":record.target_port,
        "route_id":record.route_id})
}

fn bind(port: Option<u16>) -> Result<TcpListener> {
    let listener = TcpListener::bind(("127.0.0.1", port.unwrap_or(0)))?;
    ensure!(
        listener.local_addr()?.ip().is_loopback(),
        "Proxy must bind loopback"
    );
    Ok(listener)
}

fn persist(file: &Path, records: &HashMap<Key, Arc<Route>>) -> Result<()> {
    let mut values = records
        .values()
        .map(|route| route.record.lock().unwrap().clone())
        .collect::<Vec<_>>();
    values.sort_by(|a, b| {
        (
            &a.key.workspace_id,
            &a.key.service_name,
            &a.key.port_variable,
        )
            .cmp(&(
                &b.key.workspace_id,
                &b.key.service_name,
                &b.key.port_variable,
            ))
    });
    persist_values(file, &values)
}

fn persist_values(file: &Path, values: &[Record]) -> Result<()> {
    let temporary = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut out = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        serde_json::to_writer(&mut out, &values)?;
        out.sync_all()?;
        std::fs::rename(&temporary, file)?;
        File::open(file.parent().context("Missing proxy directory")?)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn reject(client: &mut TcpStream, code: u16, message: &str) -> io::Result<()> {
    write!(
        client,
        "HTTP/1.1 {code} {message}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}",
        message.len()
    )
}

enum Body {
    Empty,
    Fixed(u64),
    Chunked,
    Upgrade,
}

fn header(client: &mut TcpStream, port: u16) -> Result<(Vec<u8>, Body)> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while bytes.len() < MAX_HEADER {
        client.set_read_timeout(Some(remaining(deadline)?))?;
        client.read_exact(&mut byte)?;
        bytes.push(byte[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    ensure!(bytes.ends_with(b"\r\n\r\n"), "HTTP header too large");
    let text = std::str::from_utf8(&bytes).context("Invalid HTTP header")?;
    let mut lines = text.split("\r\n");
    let request = lines.next().context("Missing request line")?;
    let parts = request.split_whitespace().collect::<Vec<_>>();
    ensure!(
        parts.len() == 3 && parts[1].starts_with('/') && parts[2] == "HTTP/1.1",
        "Invalid HTTP request target"
    );
    let fields = lines
        .filter_map(|line| line.split_once(':'))
        .collect::<Vec<_>>();
    let values = |name: &str| {
        fields
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
            .collect::<Vec<_>>()
    };
    let hosts = values("host");
    ensure!(
        hosts.len() == 1 && hosts[0] == format!("127.0.0.1:{port}"),
        "Invalid service proxy Host"
    );
    let lengths = values("content-length");
    let encodings = values("transfer-encoding");
    ensure!(
        lengths.len() <= 1 && encodings.len() <= 1 && !(lengths.len() == 1 && encodings.len() == 1),
        "Ambiguous HTTP request body"
    );
    let upgrades = values("upgrade");
    let connections = values("connection");
    let upgrade = !upgrades.is_empty()
        && connections.iter().any(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        });
    ensure!(
        !upgrade || (lengths.is_empty() && encodings.is_empty()),
        "Upgrade cannot carry an HTTP body"
    );
    let origins = values("origin");
    ensure!(
        origins.len() <= 1
            && origins
                .first()
                .is_none_or(|origin| { *origin == format!("http://127.0.0.1:{port}") }),
        "Cross-origin service proxy request"
    );
    let body = if upgrade {
        Body::Upgrade
    } else if let Some(value) = lengths.first() {
        Body::Fixed(value.parse::<u64>().context("Invalid Content-Length")?)
    } else if let Some(value) = encodings.first() {
        ensure!(
            value.eq_ignore_ascii_case("chunked"),
            "Unsupported Transfer-Encoding"
        );
        Body::Chunked
    } else {
        Body::Empty
    };
    Ok((bytes, body))
}

fn remaining(deadline: Instant) -> Result<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    ensure!(!left.is_zero(), "Service proxy request timed out");
    Ok(left)
}

fn read_line(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    deadline: Instant,
    total_header_bytes: &mut usize,
) -> Result<String> {
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while bytes.len() < 8192 {
        client.set_read_timeout(Some(remaining(deadline)?))?;
        client.read_exact(&mut byte)?;
        *total_header_bytes += 1;
        ensure!(*total_header_bytes <= 8192, "HTTP chunk metadata too large");
        bytes.push(byte[0]);
        upstream.write_all(&byte)?;
        if bytes.ends_with(b"\r\n") {
            return Ok(std::str::from_utf8(&bytes[..bytes.len() - 2])?.to_owned());
        }
    }
    anyhow::bail!("HTTP chunk line too large")
}

fn copy_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    mut length: u64,
    deadline: Instant,
) -> Result<()> {
    let mut bytes = [0u8; 8192];
    while length > 0 {
        client.set_read_timeout(Some(remaining(deadline)?))?;
        let limit = bytes.len().min(length as usize);
        let count = client.read(&mut bytes[..limit])?;
        ensure!(count > 0, "Incomplete HTTP request body");
        upstream.write_all(&bytes[..count])?;
        length -= count as u64;
    }
    Ok(())
}

fn send_body(client: &mut TcpStream, upstream: &mut TcpStream, body: Body) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    match body {
        Body::Empty => {}
        Body::Fixed(length) => {
            ensure!(length <= 64 * 1024 * 1024, "HTTP request body too large");
            copy_body(client, upstream, length, deadline)?;
        }
        Body::Chunked => {
            let mut total = 0u64;
            let mut metadata = 0usize;
            loop {
                let line = read_line(client, upstream, deadline, &mut metadata)?;
                let size = u64::from_str_radix(line.split(';').next().unwrap_or(""), 16)
                    .context("Invalid HTTP chunk size")?;
                total = total
                    .checked_add(size)
                    .context("HTTP request body too large")?;
                ensure!(total <= 64 * 1024 * 1024, "HTTP request body too large");
                if size == 0 {
                    loop {
                        if read_line(client, upstream, deadline, &mut metadata)?.is_empty() {
                            break;
                        }
                    }
                    break;
                }
                copy_body(client, upstream, size, deadline)?;
                let mut ending = [0u8; 2];
                client.set_read_timeout(Some(remaining(deadline)?))?;
                client.read_exact(&mut ending)?;
                ensure!(&ending == b"\r\n", "Invalid HTTP chunk ending");
                upstream.write_all(&ending)?;
            }
        }
        Body::Upgrade => unreachable!(),
    }
    Ok(())
}

fn resolve(record: &Record, connected_host: &str) -> Result<Value> {
    let mut stream = UnixStream::connect(&record.daemon_socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    writeln!(
        stream,
        "{}",
        json!({"op":"service.proxy.target",
        "workspace_id":record.key.workspace_id,"name":record.key.service_name,
        "port_variable":record.key.port_variable,"expected_port":record.target_port,
        "service_identity":record.service_identity,"connected_host":connected_host})
    )?;
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while bytes.len() < 4096 {
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            break;
        }
        bytes.push(byte[0]);
    }
    ensure!(bytes.len() < 4096, "Proxy target reply too large");
    let reply: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        reply["type"] == "service_proxy_target",
        "Service target unavailable"
    );
    ensure!(reply["host"] == connected_host, "Proxy target host changed");
    ensure!(
        reply["port"]
            .as_u64()
            .is_some_and(|port| (1..=65535).contains(&port)),
        "Invalid proxy target port"
    );
    Ok(reply)
}

fn handle(mut client: TcpStream, route: &Route) -> Result<()> {
    let record = route.record.lock().unwrap().clone();
    let (first, body) = match header(&mut client, record.port) {
        Ok(first) => first,
        Err(_) => {
            let _ = reject(&mut client, 400, "Invalid service proxy request");
            return Ok(());
        }
    };
    if route.retired.load(Ordering::Acquire) {
        let _ = reject(&mut client, 503, "Service proxy route retired");
        return Ok(());
    }
    let mut verified = None;
    for (host, address) in [
        (
            "127.0.0.1",
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), record.target_port),
        ),
        (
            "::1",
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), record.target_port),
        ),
    ] {
        if let Ok(upstream) = TcpStream::connect_timeout(&address, Duration::from_millis(500))
            && resolve(&record, host).is_ok()
        {
            verified = Some(upstream);
            break;
        }
    }
    let Some(mut upstream) = verified else {
        let _ = reject(&mut client, 503, "Service unavailable");
        return Ok(());
    };
    if matches!(body, Body::Upgrade) {
        client.set_read_timeout(None)?;
    } else {
        client.set_read_timeout(Some(Duration::from_secs(30)))?;
        client.set_write_timeout(Some(Duration::from_secs(30)))?;
        upstream.set_read_timeout(Some(Duration::from_secs(30)))?;
        upstream.set_write_timeout(Some(Duration::from_secs(30)))?;
    }
    {
        let _admission = route.admission.read().unwrap();
        if route.retired.load(Ordering::Acquire) {
            let _ = reject(&mut client, 503, "Service proxy route retired");
            return Ok(());
        }
        upstream.write_all(&first)?;
    }
    if matches!(body, Body::Upgrade) {
        let mut input = client.try_clone()?;
        let mut output = upstream.try_clone()?;
        std::thread::spawn(move || {
            let _ = io::copy(&mut input, &mut output);
            let _ = output.shutdown(Shutdown::Write);
        });
        let _ = io::copy(&mut upstream, &mut client);
    } else {
        let mut output = upstream.try_clone()?;
        let mut recipient = client.try_clone()?;
        let response = std::thread::spawn(move || {
            let _ = io::copy(&mut output, &mut recipient);
            let _ = recipient.shutdown(Shutdown::Write);
        });
        let _ = send_body(&mut client, &mut upstream, body);
        let _ = upstream.shutdown(Shutdown::Write);
        let _ = response.join();
    }
    let _ = client.shutdown(Shutdown::Both);
    Ok(())
}
