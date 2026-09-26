//! Installed-app profile and runtime controller. It uses only the shipped Rust
//! executable and OS services; development Python tools are not on this path.
mod backup;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{OpenOptionsExt, PermissionsExt},
            net::UnixStream,
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const APPLICATION_PROTOCOL: &str = "ade-application-v1";
const RUNTIME_PROTOCOL: &str = "ade-runtime-v8";

#[derive(Serialize, Deserialize, Default)]
struct Registry {
    format_version: u32,
    selected_id: Option<String>,
    profiles: Vec<Profile>,
}
#[derive(Serialize, Deserialize, Clone)]
struct Profile {
    id: String,
    name: String,
}

struct Lock(File);
impl Lock {
    fn acquire(path: &Path, wait: bool) -> Result<Self> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW);
        let file = options
            .open(path)
            .with_context(|| format!("Cannot open lock {}", path.display()))?;
        let flags = libc::LOCK_EX | if wait { 0 } else { libc::LOCK_NB };
        let result = unsafe { libc::flock(file.as_raw_fd(), flags) };
        ensure!(result == 0, "Another process owns {}", path.display());
        Ok(Self(file))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    ensure!(
        fs::symlink_metadata(path)?.file_type().is_dir(),
        "Directory is redirected: {}",
        path.display()
    );
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("File has no parent")?;
    private_dir(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}",
        path.file_name().unwrap().to_string_lossy(),
        Uuid::new_v4()
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn registry(home: &Path) -> Result<Registry> {
    let path = home.join("registry.json");
    if !path.exists() {
        return Ok(Registry {
            format_version: 2,
            ..Default::default()
        });
    }
    let value: Registry = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        value.format_version == 2,
        "Unsupported profile registry; it was left unchanged"
    );
    for item in &value.profiles {
        Uuid::parse_str(&item.id)?;
    }
    ensure!(
        value
            .selected_id
            .as_ref()
            .is_none_or(|id| value.profiles.iter().any(|item| item.id == *id)),
        "Profile registry selection is invalid"
    );
    Ok(value)
}
fn save_registry(home: &Path, value: &Registry) -> Result<()> {
    private_write(&home.join("registry.json"), &serde_json::to_vec(value)?)
}
fn profile_path(home: &Path, id: &str) -> Result<PathBuf> {
    let id = Uuid::parse_str(id)?.to_string();
    Ok(home.join("profiles").join(id))
}
fn profile_view(home: &Path, item: &Profile, selected: Option<&str>) -> Result<Value> {
    Ok(
        json!({"id":item.id,"name":item.name,"selected":selected == Some(&item.id),
        "home":profile_path(home, &item.id)?.join("runtime")}),
    )
}
fn find_profile<'a>(registry: &'a Registry, id: Option<&str>) -> Result<&'a Profile> {
    let id = id
        .or(registry.selected_id.as_deref())
        .context("No profile is selected")?;
    registry
        .profiles
        .iter()
        .find(|item| item.id == id)
        .context("Profile ID is not registered on this host")
}

fn endpoint(home: &Path) -> Result<PathBuf> {
    let home = if home.exists() {
        home.canonicalize()?
    } else {
        home.parent()
            .context("Runtime home has no parent")?
            .canonicalize()?
            .join(home.file_name().context("Runtime home has no name")?)
    };
    let digest = Sha256::digest(home.as_os_str().as_encoded_bytes());
    let token = digest
        .iter()
        .take(10)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(PathBuf::from(format!("/tmp/ade-{}-{token}.sock", unsafe {
        libc::getuid()
    })))
}
fn rpc(socket: &Path, request: &Value) -> Result<Value> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut frame = serde_json::to_vec(request)?;
    frame.push(b'\n');
    stream.write_all(&frame)?;
    let mut line = Vec::new();
    BufReader::new(stream)
        .take(128 * 1024)
        .read_until(b'\n', &mut line)?;
    ensure!(
        line.last() == Some(&b'\n'),
        "Daemon returned an incomplete control frame"
    );
    let reply: Value = serde_json::from_slice(&line)?;
    ensure!(
        reply["type"] != "error",
        "{}",
        reply["message"].as_str().unwrap_or("Daemon error")
    );
    Ok(reply)
}
fn hello(socket: &Path) -> Result<Option<Value>> {
    match rpc(socket, &json!({"op":"hello"})) {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error.chain().any(|cause| {
                cause.downcast_ref::<std::io::Error>().is_some_and(|io| {
                    matches!(
                        io.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                    )
                })
            }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
fn compatible(value: &Value) -> Result<()> {
    ensure!(
        value["application_protocol"] == APPLICATION_PROTOCOL
            && value["runtime_protocol"] == RUNTIME_PROTOCOL,
        "Existing daemon cannot hand off this runtime. Stop it through its owner first; it was left running."
    );
    Ok(())
}
fn file_digest(path: &Path) -> Result<String> {
    let mut source = File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut source, &mut hash)?;
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
fn packaged() -> bool {
    std::env::var_os("ADE_CONTROL_PACKAGED").is_some()
        || std::env::current_exe().is_ok_and(|path| {
            path.parent().is_some_and(|parent| {
                parent.file_name().is_some_and(|name| name == "MacOS")
                    && parent.parent().is_some_and(|contents| {
                        contents.file_name().is_some_and(|name| name == "Contents")
                    })
            })
        })
}
fn runtime_binding(home: &Path, data: &Path) -> Result<()> {
    let binding = home.join("runtime.json");
    if binding.exists() || binding.is_symlink() {
        ensure!(
            fs::symlink_metadata(&binding)?.file_type().is_file(),
            "Runtime binding is redirected; preserve it for review"
        );
        let saved: Value = serde_json::from_slice(&fs::read(&binding)?)?;
        ensure!(
            saved["format_version"] == 2,
            "Unsupported runtime binding; preserve this profile"
        );
        ensure!(
            saved["runtime_home"] == home.to_string_lossy().as_ref()
                && saved["data_directory"] == data.to_string_lossy().as_ref(),
            "Profile home moved from {}; runtime binding was left unchanged",
            saved["runtime_home"].as_str().unwrap_or("unknown")
        );
        return Ok(());
    }
    ensure!(
        !data.join("sessions.sqlite").exists(),
        "Existing profile data has no native runtime binding; preserve it for review"
    );
    private_dir(data)?;
    private_write(
        &binding,
        &serde_json::to_vec(&json!({"format_version":2,
        "runtime_home":home,"data_directory":data}))?,
    )
}
fn start_runtime(
    home: &Path,
    private_workspace: &Path,
    daemon: &Path,
    packaged: bool,
) -> Result<Value> {
    private_dir(home)?;
    let _launch = Lock::acquire(&home.join("launch.lock"), false)?;
    let socket = endpoint(home)?;
    let data = home.join("data");
    runtime_binding(home, &data)?;
    private_dir(&data)?;
    if let Some(current) = hello(&socket)? {
        compatible(&current)?;
        let runtime_socket = current["runtime_socket"]
            .as_str()
            .context("Running daemon omitted its runtime endpoint")?;
        let actual = rpc(Path::new(runtime_socket), &json!({"op":"hello"}))?;
        ensure!(
            actual["data_directory"] == data.to_string_lossy().as_ref(),
            "Running supervisor belongs to another data directory; recovery refused"
        );
        return Ok(json!({"socket":socket,"daemon":current}));
    }
    let runtime_bin = daemon.with_file_name("ade-runtime");
    let build_id = file_digest(daemon)?;
    let runtime_build_id = file_digest(&runtime_bin)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(home.join("daemon.log"))?;
    let mut command = Command::new(daemon);
    command
        .env("ADE_SOCKET", &socket)
        .env("ADE_DATA_DIR", &data)
        .env("ADE_BUILD_ID", build_id)
        .env("ADE_RUNTIME_BUILD_ID", runtime_build_id)
        .env("ADE_RUNTIME_HOME", home)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    if packaged {
        command
            .env_remove("ADE_ROOT")
            .env("ADE_WORKSPACE_SELECTION", "1")
            .env(
                "PATH",
                std::env::join_paths(ade_platform::tool_paths::host_tool_dirs())?,
            );
    } else {
        command.env("ADE_ROOT", private_workspace);
    }
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn().context("Could not start profile daemon")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(current) = hello(&socket)? {
            compatible(&current)?;
            ensure!(
                current["pid"] == child.id(),
                "Another daemon claimed the endpoint; it was left running"
            );
            return Ok(json!({"socket":socket,"daemon":current}));
        }
        if let Some(exit) = child.try_wait()? {
            bail!(
                "Daemon exited ({exit}); see {}",
                home.join("daemon.log").display()
            );
        }
        ensure!(
            Instant::now() < deadline,
            "Daemon is not ready; see {}",
            home.join("daemon.log").display()
        );
        thread::sleep(Duration::from_millis(50));
    }
}

fn profiles(args: &[String]) -> Result<Value> {
    let mut home = std::env::var_os("ADE_PROFILES_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                .join("Library/Application Support/lux-ade/profiles-v2")
        });
    let mut daemon = std::env::current_exe()?.with_file_name("ade-daemon");
    let mut index = 0;
    while index < args.len() && args[index].starts_with("--") {
        match args[index].as_str() {
            "--home" => home = PathBuf::from(args.get(index + 1).context("Missing --home value")?),
            "--daemon" => {
                daemon = PathBuf::from(args.get(index + 1).context("Missing --daemon value")?)
            }
            other => bail!("Unknown profile option: {other}"),
        }
        index += 2;
    }
    let action = args.get(index).context("Missing profile action")?.as_str();
    let rest = &args[index + 1..];
    private_dir(&home)?;
    let home = home.canonicalize()?;
    let _registry_lock = Lock::acquire(&home.join("registry.lock"), true)?;
    let mut value = registry(&home)?;
    match action {
        "create" => {
            let name = rest.first().context("Missing profile name")?.trim();
            ensure!(
                !name.is_empty() && name.chars().count() <= 80,
                "Profile name must contain 1 to 80 characters"
            );
            let item = Profile {
                id: Uuid::new_v4().to_string(),
                name: name.into(),
            };
            private_dir(&profile_path(&home, &item.id)?)?;
            if value.selected_id.is_none() {
                value.selected_id = Some(item.id.clone());
            }
            value.profiles.push(item.clone());
            save_registry(&home, &value)?;
            Ok(
                json!({"type":"profile","profile":profile_view(&home,&item,value.selected_id.as_deref())?}),
            )
        }
        "list" => Ok(json!({"type":"profiles","selected_id":value.selected_id,
            "profiles":value.profiles.iter().map(|item| profile_view(&home,item,value.selected_id.as_deref())).collect::<Result<Vec<_>>>()?})),
        "current" | "select" => {
            let item = find_profile(
                &value,
                if action == "select" {
                    Some(rest.first().context("Missing profile ID")?)
                } else {
                    None
                },
            )?
            .clone();
            if action == "select" {
                value.selected_id = Some(item.id.clone());
                save_registry(&home, &value)?;
            }
            Ok(
                json!({"type":"profile","profile":profile_view(&home,&item,value.selected_id.as_deref())?}),
            )
        }
        "start" => {
            let item = find_profile(&value, rest.first().map(String::as_str))?;
            let path = profile_path(&home, &item.id)?;
            let runtime = path.join("runtime");
            let workspace = path.join("workspace");
            private_dir(&workspace)?;
            let launched = start_runtime(&runtime, &workspace, &daemon, packaged())?;
            Ok(
                json!({"type":"profile_started","profile":profile_view(&home,item,value.selected_id.as_deref())?,
                "socket":launched["socket"],"daemon":launched["daemon"]}),
            )
        }
        "backup-backend" | "restore-backend" | "pending-restores" | "resume-restore" => {
            backup::profile_command(&home, &mut value, action, rest)
        }
        _ => bail!("Unknown profile action: {action}"),
    }
}

fn browser_lease(path: &Path) -> Result<()> {
    // The parent owns stdin. EOF releases the OS lock even after a crash.
    let lease = Lock::acquire(path, false);
    let _lease = match lease {
        Ok(lease) => lease,
        Err(_) => {
            println!("busy");
            std::io::stdout().flush()?;
            return Ok(());
        }
    };
    println!("ready");
    std::io::stdout().flush()?;
    let mut buffer = [0u8; 4096];
    while std::io::stdin().read(&mut buffer)? != 0 {}
    Ok(())
}

fn runtime_command(args: &[String]) -> Result<Value> {
    let action = args.first().context("Missing runtime action")?;
    let index = args
        .iter()
        .position(|item| item == "--home")
        .context("Missing --home")?;
    let home = PathBuf::from(args.get(index + 1).context("Missing runtime home")?);
    if action == "locate" {
        return Ok(json!({"socket":endpoint(&home)?}));
    }
    if action == "bind" {
        private_dir(&home)?;
        let home = home.canonicalize()?;
        let data = home.join("data");
        ensure!(
            fs::symlink_metadata(&data)?.file_type().is_dir(),
            "Restored data directory is redirected"
        );
        ensure!(
            !home.join("runtime.json").exists() && !home.join("runtime.json").is_symlink(),
            "Runtime binding already exists; it was left unchanged"
        );
        ensure!(
            hello(&endpoint(&home)?)?.is_none(),
            "A daemon already owns this runtime home"
        );
        let db = rusqlite::Connection::open_with_flags(
            data.join("sessions.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let fence: (i64,i64) = db.query_row("SELECT worktree_lifecycle_needs_rebind,restored_from_backup FROM restore_fence WHERE id=1", [],
            |row| Ok((row.get(0)?,row.get(1)?)))?;
        ensure!(
            version == 15 && fence == (1, 1),
            "Only a fenced current-schema restore can bind a fresh runtime home"
        );
        let check: String = db.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        ensure!(check == "ok", "Restored profile database is invalid");
        private_write(
            &home.join("runtime.json"),
            &serde_json::to_vec(&json!({
                "format_version":2,"runtime_home":home,"data_directory":data
            }))?,
        )?;
        return Ok(json!({"type":"runtime_bound","home":home,"data_directory":data}));
    }
    let home = home.canonicalize().context("Runtime home is unavailable")?;
    let socket = endpoint(&home)?;
    let current = hello(&socket)?;
    if action == "status" {
        return Ok(json!({"socket":socket,"daemon":current,
        "data_directory":home.join("data")}));
    }
    ensure!(action == "restart", "Unsupported runtime action");
    let binary = args
        .iter()
        .position(|item| item == "--daemon")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name("ade-daemon"));
    let old = current.context("No running daemon to restart")?;
    compatible(&old)?;
    let boot = old["boot_id"]
        .as_str()
        .context("Running daemon omitted its boot identity")?;
    rpc(
        &socket,
        &json!({"op":"runtime.prepare_restart","boot_id":boot}),
    )?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(lock) = Lock::acquire(&home.join("data/writer.lock"), false) {
            drop(lock);
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "Old daemon did not release its writer lock"
        );
        thread::sleep(Duration::from_millis(50));
    }
    let launched = start_runtime(
        &home,
        &home
            .parent()
            .context("Runtime has no profile")?
            .join("workspace"),
        &binary,
        packaged(),
    )?;
    ensure!(
        launched["daemon"]["boot_id"] != old["boot_id"],
        "Replacement did not change daemon identity"
    );
    ensure!(
        launched["daemon"]["runtime_instance"] == old["runtime_instance"],
        "Replacement did not preserve runtime identity"
    );
    Ok(launched)
}

fn run() -> Result<Value> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("profiles") => profiles(&args[1..]),
        Some("locate") => {
            ensure!(
                args.get(1).map(String::as_str) == Some("--home"),
                "locate requires --home"
            );
            let home = Path::new(args.get(2).context("Missing runtime home")?);
            Ok(json!({"socket":endpoint(home)?}))
        }
        Some("browser-lease") => {
            browser_lease(Path::new(
                args.get(1).context("Missing browser lease path")?,
            ))?;
            Ok(Value::Null)
        }
        Some("runtime") => runtime_command(&args[1..]),
        Some("backup") => backup::command(&args[1..]),
        _ => bail!("Expected profiles, locate, browser-lease, or backup"),
    }
}
fn main() {
    match run() {
        Ok(Value::Null) => {}
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{}", json!({"type":"error","message":format!("{error:#}")}));
            std::process::exit(1);
        }
    }
}
