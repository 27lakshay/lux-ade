//! `device.*` operations (F098–F100, D12): the host adapters for screen
//! access, iOS simulators and Android devices.
//!
//! The pure decisions live in [`crate::devices`]; this module runs the tools,
//! asks macOS for permission state and keeps effect receipts in the profile
//! database. Every targeted operation re-discovers its exact device and
//! refuses when that device is gone or cannot take the operation now. An
//! effect records its receipt before it runs; a receipt left open by an
//! earlier daemon process is reconciled by observing the device, and an
//! effect whose outcome cannot be observed becomes unknown. Nothing is rerun.
use super::*;
use crate::devices::{
    self as core, AndroidProbe, AndroidTools, BootReplay, IosProbe, Permissions, RunningAndroid,
    Target,
};
use crate::receipts::{self, Admission, Status};
use ade_core::contract::devices::{
    DeviceAppInstallRequest, DeviceAppInstalled, DeviceAppLaunchRequest, DeviceAppLaunched,
    DeviceBootRequest, DeviceBooted, DeviceCapability, DeviceFamily, DeviceFamilyStatus,
    DeviceHost, DeviceInventory, DeviceListRequest, DeviceScreenshot, DeviceScreenshotRequest,
    DeviceState, DeviceSummary,
};
use ade_core::model::now_ms;
use base64::Engine;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);
const TEXT_LIMIT: usize = 4 * 1024 * 1024;

// ---- Process execution -------------------------------------------------------

struct Ran {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
}

impl Ran {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// The first stderr line, bounded, for an error message.
    fn detail(&self) -> String {
        let line = self
            .stderr
            .lines()
            .chain(String::from_utf8_lossy(&self.stdout).lines())
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("no output")
            .to_owned();
        line.chars().take(300).collect()
    }
}

fn reader(
    mut pipe: impl std::io::Read + Send + 'static,
    limit: usize,
) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut buffer = [0u8; 16 * 1024];
        let mut over = false;
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if out.len() + size > limit {
                        over = true;
                    } else {
                        out.extend_from_slice(&buffer[..size]);
                    }
                }
            }
        }
        (out, over)
    })
}

/// Runs a tool with a deadline and bounded output. A tool still running at
/// the deadline is killed and reported, never assumed finished.
fn run(program: &Path, args: &[&str], timeout: Duration, limit: usize) -> Result<Ran> {
    let name = program
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut child = Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| format!("Could not run {name}"))?;
    let stdout = reader(child.stdout.take().context("Missing tool stdout")?, limit);
    let stderr = reader(
        child.stderr.take().context("Missing tool stderr")?,
        64 * 1024,
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{name} did not finish within {} seconds", timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // A tool that started a background server (adb) may leave it holding the
    // pipes; wait briefly for the readers, never for the server.
    let finish = |handle: std::thread::JoinHandle<(Vec<u8>, bool)>| -> Option<(Vec<u8>, bool)> {
        let until = Instant::now() + Duration::from_secs(2);
        while !handle.is_finished() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        handle.is_finished().then(|| handle.join().ok()).flatten()
    };
    let (stdout, over) = finish(stdout).with_context(|| format!("{name} output did not close"))?;
    ensure!(!over, "{name} output exceeded {limit} bytes");
    let stderr = finish(stderr).map(|(bytes, _)| bytes).unwrap_or_default();
    Ok(Ran {
        success: status.success(),
        stdout,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

fn run_ok(program: &Path, args: &[&str], timeout: Duration, limit: usize) -> Result<Ran> {
    let ran = run(program, args, timeout, limit)?;
    let name = program.file_name().unwrap_or_default().to_string_lossy();
    ensure!(ran.success, "{name} failed: {}", ran.detail());
    Ok(ran)
}

fn find_tool(name: &str) -> Option<PathBuf> {
    ade_platform::tool_paths::host_tool_dirs()
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

// ---- Host identity -----------------------------------------------------------

fn machine_id() -> Result<String> {
    if cfg!(target_os = "macos") {
        let ran = run_ok(
            Path::new("/usr/sbin/ioreg"),
            &["-rd1", "-c", "IOPlatformExpertDevice"],
            LIST_TIMEOUT,
            TEXT_LIMIT,
        )?;
        core::parse_ioreg_platform_uuid(&ran.text()).context("ioreg reported no IOPlatformUUID")
    } else {
        let text = std::fs::read_to_string("/etc/machine-id")
            .or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id"))
            .context("The host has no machine ID")?;
        ensure!(!text.trim().is_empty(), "The host machine ID is empty");
        Ok(text.trim().to_owned())
    }
}

fn host_name() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for its full length, and gethostname
    // writes at most that many bytes.
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    let length = buffer.iter().position(|byte| *byte == 0).unwrap_or(0);
    if result != 0 || length == 0 {
        return "unknown".into();
    }
    String::from_utf8_lossy(&buffer[..length]).into_owned()
}

/// This host's identity. Without one, no device operation runs.
fn host() -> Result<DeviceHost> {
    static HOST_ID: OnceLock<String> = OnceLock::new();
    let host_id = match HOST_ID.get() {
        Some(id) => id.clone(),
        None => {
            let id = core::host_id(
                &machine_id()
                    .context("Device host identity is unavailable; no device operation runs")?,
            );
            HOST_ID.get_or_init(|| id).clone()
        }
    };
    Ok(DeviceHost {
        host_id,
        host_name: host_name(),
        platform: std::env::consts::OS.into(),
    })
}

// ---- macOS screen access -------------------------------------------------------

#[cfg(target_os = "macos")]
mod mac {
    use crate::devices::Display;
    use ade_core::contract::devices::DevicePermissionState;
    use std::ffi::{c_char, c_void};

    type CfRef = *const c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayPixelsWide(display: u32) -> usize;
        fn CGDisplayPixelsHigh(display: u32) -> usize;
        fn CGDisplayIsBuiltin(display: u32) -> u32;
    }

    #[link(name = "ColorSync", kind = "framework")]
    unsafe extern "C" {
        fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> CfRef;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFUUIDCreateString(allocator: CfRef, uuid: CfRef) -> CfRef;
        fn CFStringGetCString(string: CfRef, buffer: *mut c_char, size: isize, encoding: u32)
        -> u8;
        fn CFRelease(value: CfRef);
    }

    const UTF8: u32 = 0x0800_0100;

    fn state(granted: bool) -> DevicePermissionState {
        if granted {
            DevicePermissionState::Granted
        } else {
            DevicePermissionState::Denied
        }
    }

    /// Asks without prompting: neither call shows a consent dialog.
    pub fn permissions() -> (DevicePermissionState, DevicePermissionState) {
        // SAFETY: both functions take no arguments and only read TCC state.
        let (screen, accessibility) =
            unsafe { (CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() != 0) };
        (state(screen), state(accessibility))
    }

    fn uuid(display: u32) -> Option<String> {
        // SAFETY: the UUID and string are CoreFoundation objects this function
        // creates and releases exactly once; the buffer outlives the call.
        unsafe {
            let uuid = CGDisplayCreateUUIDFromDisplayID(display);
            if uuid.is_null() {
                return None;
            }
            let string = CFUUIDCreateString(std::ptr::null(), uuid);
            CFRelease(uuid);
            if string.is_null() {
                return None;
            }
            let mut buffer = [0 as c_char; 64];
            let ok = CFStringGetCString(string, buffer.as_mut_ptr(), buffer.len() as isize, UTF8);
            CFRelease(string);
            (ok != 0).then(|| {
                std::ffi::CStr::from_ptr(buffer.as_ptr())
                    .to_string_lossy()
                    .into_owned()
            })
        }
    }

    pub fn displays() -> Result<Vec<Display>, String> {
        let mut ids = [0u32; 32];
        let mut count = 0u32;
        // SAFETY: `ids` has room for the 32 displays requested and `count`
        // is a valid out pointer.
        let error = unsafe { CGGetActiveDisplayList(32, ids.as_mut_ptr(), &raw mut count) };
        if error != 0 {
            return Err(format!(
                "CoreGraphics could not list displays (error {error})"
            ));
        }
        // SAFETY: takes no arguments.
        let main = unsafe { CGMainDisplayID() };
        let mut displays = Vec::new();
        for &id in &ids[..count.min(32) as usize] {
            let Some(uuid) = uuid(id) else {
                return Err("CoreGraphics reported a display without a UUID".into());
            };
            // SAFETY: `id` came from the active display list.
            let (width, height, builtin) = unsafe {
                (
                    CGDisplayPixelsWide(id) as u64,
                    CGDisplayPixelsHigh(id) as u64,
                    CGDisplayIsBuiltin(id) != 0,
                )
            };
            displays.push(Display {
                uuid: uuid.to_ascii_uppercase(),
                width,
                height,
                main: id == main,
                builtin,
            });
        }
        Ok(displays)
    }
}

fn computer() -> (DeviceFamilyStatus, Vec<DeviceSummary>) {
    #[cfg(target_os = "macos")]
    {
        let (screen_recording, accessibility) = mac::permissions();
        core::classify_computer(
            true,
            Permissions {
                screen_recording,
                accessibility,
            },
            mac::displays(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        core::classify_computer(
            false,
            Permissions {
                screen_recording: ade_core::contract::devices::DevicePermissionState::Unsupported,
                accessibility: ade_core::contract::devices::DevicePermissionState::Unsupported,
            },
            Ok(vec![]),
        )
    }
}

// ---- iOS simulators ------------------------------------------------------------

fn xcrun() -> Option<PathBuf> {
    let path = PathBuf::from("/usr/bin/xcrun");
    path.is_file().then_some(path)
}

fn ios_probe() -> IosProbe {
    if !cfg!(target_os = "macos") {
        return IosProbe::NotMacos;
    }
    let Some(xcrun) = xcrun() else {
        return IosProbe::ToolMissing("xcrun is not installed; install Xcode".into());
    };
    match run(
        &xcrun,
        &["simctl", "list", "devices", "-j"],
        LIST_TIMEOUT,
        TEXT_LIMIT,
    ) {
        Ok(ran) if ran.success => match core::parse_simctl_devices(&ran.text()) {
            Ok(simulators) => IosProbe::Listed {
                xcrun: xcrun.display().to_string(),
                simulators,
            },
            Err(error) => IosProbe::ToolFailed(error.to_string()),
        },
        Ok(ran) if core::simctl_missing(&ran.stderr) => IosProbe::ToolMissing(
            "Xcode Simulator tools are unavailable. Install Xcode, open it once, then select it with xcode-select".into(),
        ),
        Ok(ran) => IosProbe::ToolFailed(format!("xcrun simctl failed: {}", ran.detail())),
        Err(error) => IosProbe::ToolFailed(error.to_string()),
    }
}

fn simctl(args: &[&str], timeout: Duration) -> Result<Ran> {
    let xcrun = xcrun().context("xcrun is not installed")?;
    let mut all = vec!["simctl"];
    all.extend_from_slice(args);
    run(&xcrun, &all, timeout, TEXT_LIMIT)
}

/// The installed version of `bundle` on a simulator, or None when absent.
fn ios_installed_version(udid: &str, bundle: &str) -> Result<Option<String>> {
    let ran = simctl(&["get_app_container", udid, bundle, "app"], LIST_TIMEOUT)?;
    if !ran.success {
        return Ok(None);
    }
    let container = PathBuf::from(ran.text().trim());
    plist_value(&container.join("Info.plist"), "CFBundleVersion").map(Some)
}

fn plist_value(plist: &Path, key: &str) -> Result<String> {
    let path = plist.to_str().context("The app path is not UTF-8")?;
    let ran = run_ok(
        Path::new("/usr/bin/plutil"),
        &["-extract", key, "raw", "-o", "-", path],
        LIST_TIMEOUT,
        64 * 1024,
    )?;
    core::parse_plist_raw(&ran.text(), key)
}

// ---- Android ---------------------------------------------------------------------

fn android_tools() -> AndroidTools {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let roots = core::sdk_roots(
        std::env::var("ANDROID_HOME").ok().as_deref(),
        std::env::var("ANDROID_SDK_ROOT").ok().as_deref(),
        home.as_deref(),
        cfg!(target_os = "macos"),
    );
    let mut tools = AndroidTools::default();
    for root in &roots {
        let adb = root.join("platform-tools/adb");
        if tools.adb.is_none() && adb.is_file() {
            tools.adb = Some(adb);
        }
        let emulator = root.join("emulator/emulator");
        if tools.emulator.is_none() && emulator.is_file() {
            tools.emulator = Some(emulator);
        }
        if tools.aapt.is_none() {
            let names: Vec<String> = std::fs::read_dir(root.join("build-tools"))
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect();
            if let Some(version) = core::newest_build_tools(&names) {
                let dir = root.join("build-tools").join(version);
                tools.aapt = [dir.join("aapt2"), dir.join("aapt")]
                    .into_iter()
                    .find(|path| path.is_file());
            }
        }
    }
    if tools.adb.is_none() {
        tools.adb = find_tool("adb");
    }
    if tools.emulator.is_none() {
        tools.emulator = find_tool("emulator");
    }
    tools
}

fn adb(tools: &AndroidTools, args: &[&str], timeout: Duration, limit: usize) -> Result<Ran> {
    let adb = tools.adb.as_deref().context("adb was not found")?;
    run(adb, args, timeout, limit)
}

fn emulator_avd(tools: &AndroidTools, serial: &str) -> Option<String> {
    let ran = adb(
        tools,
        &["-s", serial, "emu", "avd", "name"],
        LIST_TIMEOUT,
        64 * 1024,
    )
    .ok()?;
    ran.success
        .then(|| core::parse_emu_avd_name(&ran.text()))
        .flatten()
}

fn running_android(tools: &AndroidTools) -> Result<Vec<RunningAndroid>, String> {
    let ran = adb(tools, &["devices", "-l"], LIST_TIMEOUT, TEXT_LIMIT)
        .map_err(|error| error.to_string())?;
    if !ran.success {
        return Err(format!("adb devices failed: {}", ran.detail()));
    }
    Ok(core::parse_adb_devices(&ran.text())
        .into_iter()
        .map(|device| {
            let online = device.state == "device";
            let avd = (online && device.is_emulator())
                .then(|| emulator_avd(tools, &device.serial))
                .flatten();
            let boot_completed = online
                && adb(
                    tools,
                    &[
                        "-s",
                        &device.serial,
                        "shell",
                        "getprop",
                        "sys.boot_completed",
                    ],
                    LIST_TIMEOUT,
                    64 * 1024,
                )
                .is_ok_and(|ran| ran.success && core::boot_completed(&ran.text()));
            RunningAndroid {
                device,
                avd,
                boot_completed,
            }
        })
        .collect())
}

fn android_probe() -> AndroidProbe {
    let tools = android_tools();
    let running = if tools.adb.is_some() {
        running_android(&tools)
    } else {
        Ok(vec![])
    };
    let avds = match &tools.emulator {
        None => Ok(vec![]),
        Some(emulator) => match run(emulator, &["-list-avds"], LIST_TIMEOUT, TEXT_LIMIT) {
            Ok(ran) if ran.success => Ok(core::parse_avd_list(&ran.text())),
            Ok(ran) => Err(format!("emulator -list-avds failed: {}", ran.detail())),
            Err(error) => Err(error.to_string()),
        },
    };
    AndroidProbe {
        tools,
        running,
        avds,
    }
}

/// The current adb serial of an Android target, confirmed against its AVD.
fn android_serial(tools: &AndroidTools, device: &DeviceSummary, target: &Target) -> Result<String> {
    let serial = device
        .serial
        .clone()
        .with_context(|| format!("Device {} is not running", device.device_id))?;
    confirm_serial(tools, &serial, target)?;
    Ok(serial)
}

/// An emulator serial is a port, so another AVD can take it; re-read it.
fn confirm_serial(tools: &AndroidTools, serial: &str, target: &Target) -> Result<()> {
    if let Target::AndroidAvd(name) = target {
        ensure!(
            emulator_avd(tools, serial).as_deref() == Some(name.as_str()),
            "Device android-avd:{name} is unavailable: serial {serial} no longer belongs to it"
        );
    }
    Ok(())
}

fn android_installed_version(
    tools: &AndroidTools,
    serial: &str,
    package: &str,
) -> Result<Option<String>> {
    let ran = adb(
        tools,
        &["-s", serial, "shell", "dumpsys", "package", package],
        LIST_TIMEOUT,
        TEXT_LIMIT,
    )?;
    ensure!(ran.success, "adb could not read packages: {}", ran.detail());
    Ok(core::parse_dumpsys_version_code(&ran.text(), package))
}

// ---- Inventory -------------------------------------------------------------------

struct Probed {
    host: DeviceHost,
    families: Vec<DeviceFamilyStatus>,
    devices: Vec<DeviceSummary>,
    android: Option<AndroidTools>,
}

fn probe(only: Option<DeviceFamily>) -> Result<Probed> {
    let host = host()?;
    let mut families = Vec::new();
    let mut devices = Vec::new();
    let mut android = None;
    let wanted = |family| only.is_none_or(|only| only == family);
    if wanted(DeviceFamily::Computer) {
        let (status, found) = computer();
        families.push(status);
        devices.extend(found);
    }
    if wanted(DeviceFamily::IosSimulator) {
        let (status, found) = core::classify_ios(ios_probe());
        families.push(status);
        devices.extend(found);
    }
    if wanted(DeviceFamily::Android) {
        let probe = android_probe();
        android = Some(probe.tools.clone());
        let (status, found) = core::classify_android(probe);
        families.push(status);
        devices.extend(found);
    }
    Ok(Probed {
        host,
        families,
        devices,
        android,
    })
}

/// Probes the target's family and checks the request names this host.
fn locate(host_id: &str, device_id: &str) -> Result<(Target, Probed)> {
    let target = Target::parse(device_id)?;
    let own = host()?;
    core::require_host(&own.host_id, host_id)?;
    let probed = probe(Some(target.family()))?;
    Ok((target, probed))
}

fn state_of(probed: &Probed, device_id: &str) -> Option<DeviceState> {
    probed
        .devices
        .iter()
        .find(|device| device.device_id == device_id)
        .map(|device| device.state)
}

// ---- Screenshots -------------------------------------------------------------------

/// A private directory for one capture, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let path = std::env::temp_dir().join(format!("ade-device-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .context("Could not create a private capture directory")?;
        Ok(Self(path))
    }

    fn file(&self) -> PathBuf {
        self.0.join("capture.png")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn read_png(path: &Path) -> Result<Vec<u8>> {
    let size = std::fs::metadata(path)
        .context("The capture tool wrote no image")?
        .len();
    ensure!(
        size as usize <= core::MAX_SCREENSHOT_BYTES,
        "The screenshot exceeds 16 MiB"
    );
    Ok(std::fs::read(path)?)
}

fn capture(target: &Target, device: &DeviceSummary, probed: &Probed) -> Result<Vec<u8>> {
    match target {
        Target::Display(uuid) => {
            #[cfg(target_os = "macos")]
            {
                let before = mac::displays().map_err(|error| anyhow!(error))?;
                // classify_computer offers capture only with exactly one
                // display, so `-D 1` cannot name another display.
                let display = match before.as_slice() {
                    [only] if &only.uuid == uuid => only.clone(),
                    _ => bail!(
                        "Device {} is unavailable: the displays changed",
                        device.device_id
                    ),
                };
                let scratch = Scratch::new()?;
                let file = scratch.file();
                let path = file.to_str().context("Temporary path is not UTF-8")?;
                run_ok(
                    Path::new("/usr/sbin/screencapture"),
                    &["-x", "-D", "1", "-t", "png", path],
                    CAPTURE_TIMEOUT,
                    64 * 1024,
                )?;
                let png = read_png(&file)?;
                let after = mac::displays().map_err(|error| anyhow!(error))?;
                ensure!(
                    after == before,
                    "The displays changed during capture; the image was discarded"
                );
                let dims = core::png_dimensions(&png).context("The capture is not a PNG")?;
                ensure!(
                    core::png_matches_display(dims, &display),
                    "The capture does not match display {uuid}; the image was discarded"
                );
                Ok(png)
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (uuid, device, probed);
                bail!("Screen access is implemented for macOS hosts only")
            }
        }
        Target::IosSimulator(udid) => {
            let scratch = Scratch::new()?;
            let file = scratch.file();
            let path = file.to_str().context("Temporary path is not UTF-8")?;
            let ran = simctl(
                &["io", udid, "screenshot", "--type=png", path],
                CAPTURE_TIMEOUT,
            )?;
            ensure!(ran.success, "simctl screenshot failed: {}", ran.detail());
            read_png(&file)
        }
        Target::AndroidAvd(_) | Target::AndroidSerial(_) => {
            let tools = probed.android.clone().unwrap_or_default();
            let serial = android_serial(&tools, device, target)?;
            let ran = adb(
                &tools,
                &["-s", &serial, "exec-out", "screencap", "-p"],
                CAPTURE_TIMEOUT,
                core::MAX_SCREENSHOT_BYTES,
            )?;
            ensure!(ran.success, "adb screencap failed: {}", ran.detail());
            confirm_serial(&tools, &serial, target)?;
            Ok(ran.stdout)
        }
    }
}

// ---- Effects -----------------------------------------------------------------------

/// Holds an operation ID and its device for one in-process effect.
struct Claim(Vec<String>);

fn claims() -> &'static Mutex<HashSet<String>> {
    static CLAIMS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CLAIMS.get_or_init(|| Mutex::new(HashSet::new()))
}

impl Claim {
    fn acquire(device_id: &str, operation_id: &str) -> Result<Self> {
        let keys = vec![
            format!("op\0{operation_id}"),
            format!("device\0{device_id}"),
        ];
        let mut held = claims().lock().unwrap_or_else(|poison| poison.into_inner());
        ensure!(
            !held.contains(&keys[0]),
            "Operation {operation_id} is still running"
        );
        ensure!(
            !held.contains(&keys[1]),
            "Another device operation is running on {device_id}; retry when it finishes"
        );
        held.extend(keys.iter().cloned());
        Ok(Self(keys))
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut held = claims().lock().unwrap_or_else(|poison| poison.into_inner());
        for key in &self.0 {
            held.remove(key);
        }
    }
}

/// The host-wide exclusive claim on a simulator or emulator for one effect,
/// so another profile cannot boot, install to or launch on it meanwhile. It
/// settles by the effect's receipt when dropped: an outcome that was not
/// observed leaves the claim quarantined. Take it after [`Claim`], so it is
/// dropped first.
struct HostClaim<'a> {
    sessions: &'a Sessions,
    claim: Option<String>,
    operation_id: String,
}

impl<'a> HostClaim<'a> {
    fn acquire(sessions: &'a Sessions, device_id: &str, operation_id: &str) -> Result<Self> {
        let claim = match crate::host_resources::device_claim_id(device_id)? {
            Some(device) => Some(sessions.worktrees.host_resources().claim_device(
                &device,
                None,
                Some(operation_id),
            )?),
            None => None,
        };
        Ok(Self {
            sessions,
            claim,
            operation_id: operation_id.to_owned(),
        })
    }
}

impl Drop for HostClaim<'_> {
    fn drop(&mut self) {
        let Some(claim) = &self.claim else { return };
        let status = self.sessions.device_db(false, |db| {
            let status: Option<String> = rusqlite::OptionalExtension::optional(db.query_row(
                "SELECT status FROM operations WHERE id=?1",
                [&self.operation_id],
                |row| row.get(0),
            ))?;
            status.map(|status| Status::parse(&status)).transpose()
        });
        let settlement = match status {
            Ok(status) => crate::host_resources::settle_effect(status),
            // An unreadable receipt proves nothing about the device.
            Err(_) => crate::host_resources::Settlement::Quarantine("receipt_unreadable"),
        };
        self.sessions
            .worktrees
            .host_resources()
            .settle(claim, settlement);
    }
}

fn operation_id(value: &str) -> Result<&str> {
    ensure!(
        !value.is_empty() && value.len() <= 512,
        "Missing or invalid operation_id"
    );
    Ok(value)
}

fn outcome(result: &Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok": value}),
        Err(error) => json!({"error": error.to_string()}),
    }
}

/// What reconciling an open receipt found.
enum Reconciled {
    /// The effect's outcome is observable; settle it.
    Settle(Result<Value>),
    /// Still in progress; leave the receipt open.
    Pending(String),
    /// The outcome cannot be observed; mark it unknown.
    Unknown(String),
}

impl Sessions {
    fn device_db<T>(&self, effect: bool, step: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let d = self.data.lock().unwrap();
        ensure!(!(effect && d.draining), "Application daemon is restarting");
        receipts::ensure(&d.store.connection)?;
        step(&d.store.connection)
    }

    /// Looks an operation ID up without recording anything.
    fn device_peek(&self, id: &str, op: &str, request: &Value) -> Result<Admission> {
        self.device_db(true, |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            receipts::begin(&tx, id, op, request, Some("device"), now_ms())
        })
    }

    /// Records a dispatched receipt carrying the facts reconciliation needs.
    fn device_dispatch(
        &self,
        id: &str,
        op: &str,
        request: &Value,
        record: &Value,
    ) -> Result<Admission> {
        self.device_db(true, |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            let admission = receipts::begin(&tx, id, op, request, Some("device"), now_ms())?;
            if admission == Admission::New {
                receipts::settle(&tx, id, Status::Dispatched, Some(record), now_ms())?;
                tx.commit()?;
            }
            Ok(admission)
        })
    }

    fn device_settle(&self, id: &str, status: Status, result: &Value) -> Result<()> {
        self.device_db(false, |db| {
            receipts::settle(db, id, status, Some(result), now_ms())
        })
    }

    /// Settles an effect. If the receipt cannot be saved, the caller learns
    /// that, not the outcome it could not record.
    fn device_finish(&self, id: &str, result: Result<Value>) -> Result<Value> {
        self.device_settle(id, Status::Settled, &outcome(&result))
            .with_context(|| {
                format!("Operation {id} ran but its outcome was not recorded; retry with the same operation ID to reconcile it")
            })?;
        result
    }

    fn device_unknown(&self, id: &str, detail: String) -> Result<Value> {
        self.device_settle(id, Status::Unknown, &json!({"error": detail}))?;
        bail!(
            "Operation {id} outcome is unknown: {detail}. It was not run again; inspect the device and use a new operation ID"
        )
    }

    /// Answers a known operation ID. The caller holds the ID's claim, so an
    /// open receipt belongs to an earlier daemon process or an earlier deadline.
    fn device_replay(
        &self,
        id: &str,
        admission: Admission,
        reconcile: impl FnOnce(&Value) -> Reconciled,
    ) -> Result<Value> {
        let receipt = match admission {
            Admission::New => bail!("Operation {id} was not admitted"),
            Admission::Conflict => bail!("Operation ID was already used for different parameters"),
            Admission::Expired => {
                bail!("Operation ID is past its 30-day receipt retention; use a new operation ID")
            }
            Admission::Replay(receipt) => receipt,
        };
        let record = receipt.result.unwrap_or(Value::Null);
        match receipt.status {
            Status::Settled => match (record.get("ok"), record["error"].as_str()) {
                (Some(value), _) => Ok(value.clone()),
                (None, Some(error)) => bail!("{error}"),
                (None, None) => bail!("Operation {id} has an unreadable receipt"),
            },
            Status::Unknown => bail!(
                "Operation {id} outcome is unknown: {}. It was not run again; inspect the device and use a new operation ID",
                record["error"].as_str().unwrap_or("no detail")
            ),
            Status::Accepted | Status::Dispatched | Status::Acknowledged => {
                match reconcile(&record) {
                    Reconciled::Settle(result) => self.device_finish(id, result),
                    Reconciled::Pending(detail) => bail!("{detail}"),
                    Reconciled::Unknown(detail) => self.device_unknown(id, detail),
                }
            }
        }
    }

    pub(super) fn device_command(&self, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "device.list" => {
                let list: DeviceListRequest = decode(request)?;
                let probed = probe(list.family)?;
                reply(&DeviceInventory {
                    tag: Default::default(),
                    host: probed.host,
                    families: probed.families,
                    devices: probed.devices,
                    observed_at_ms: now_ms(),
                })
            }
            "device.screenshot" => {
                let shot: DeviceScreenshotRequest = decode(request)?;
                let (target, probed) = locate(&shot.host_id, &shot.device_id)?;
                let device = core::require(
                    &probed.devices,
                    &shot.device_id,
                    DeviceCapability::Screenshot,
                )?;
                let png = capture(&target, device, &probed)?;
                ensure!(
                    png.len() <= core::MAX_SCREENSHOT_BYTES,
                    "The screenshot exceeds 16 MiB"
                );
                let (width, height) = core::png_dimensions(&png)
                    .context("The device returned an image that is not a PNG")?;
                reply(&DeviceScreenshot {
                    tag: Default::default(),
                    host_id: shot.host_id,
                    device_id: shot.device_id,
                    mime: Default::default(),
                    width,
                    height,
                    bytes: png.len() as u64,
                    sha256: Sha256::digest(&png)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                    captured_at_ms: now_ms(),
                    bytes_base64: base64::engine::general_purpose::STANDARD.encode(&png),
                })
            }
            "device.boot" => self.device_boot(request),
            "device.app.install" => self.device_install(request),
            "device.app.launch" => self.device_launch(request),
            _ => bail!("Unknown device operation"),
        }
    }

    fn device_boot(&self, request: &Value) -> Result<Value> {
        const OP: &str = "device.boot";
        let boot: DeviceBootRequest = decode(request)?;
        let id = operation_id(&boot.operation_id)?;
        let timeout = Duration::from_millis(core::boot_timeout(boot.timeout_ms)?);
        let _claim = Claim::acquire(&boot.device_id, id)?;
        let _host = HostClaim::acquire(self, &boot.device_id, id)?;
        let (target, probed) = locate(&boot.host_id, &boot.device_id)?;
        let booted = |already_booted: bool, serial: Option<String>| {
            reply(&DeviceBooted {
                tag: Default::default(),
                operation_id: boot.operation_id.clone(),
                host_id: boot.host_id.clone(),
                device_id: boot.device_id.clone(),
                already_booted,
                serial,
            })
        };
        let reconcile = |record: &Value| {
            let serial = || {
                probed
                    .devices
                    .iter()
                    .find(|device| device.device_id == boot.device_id)
                    .and_then(|device| device.serial.clone())
            };
            match core::decide_boot_replay(state_of(&probed, &boot.device_id)) {
                BootReplay::Booted => Reconciled::Settle(booted(
                    record["already_booted"].as_bool().unwrap_or(false),
                    serial(),
                )),
                BootReplay::StillBooting => Reconciled::Pending(format!(
                    "Device {} is still booting; repeat operation {id} later to reconcile it",
                    boot.device_id
                )),
                BootReplay::NotBooted => Reconciled::Settle(Err(anyhow!(
                    "The boot of {} was interrupted and the device is not booted; it was not retried. Use a new operation ID to boot it",
                    boot.device_id
                ))),
            }
        };
        let admission = self.device_peek(id, OP, request)?;
        if admission != Admission::New {
            return self.device_replay(id, admission, reconcile);
        }
        let device = probed
            .devices
            .iter()
            .find(|device| device.device_id == boot.device_id)
            .with_context(|| {
                format!(
                    "Device {} is unavailable: it is not attached to this host now",
                    boot.device_id
                )
            })?;
        let already = device.state == DeviceState::Booted;
        let joinable = device.state == DeviceState::Booting
            && matches!(target, Target::IosSimulator(_) | Target::AndroidAvd(_));
        if !already && !joinable {
            core::require(&probed.devices, &boot.device_id, DeviceCapability::Boot)?;
        }
        let record = json!({"op": OP, "device_id": boot.device_id, "already_booted": already});
        let admission = self.device_dispatch(id, OP, request, &record)?;
        if admission != Admission::New {
            return self.device_replay(id, admission, reconcile);
        }
        if already {
            return self.device_finish(id, booted(true, device.serial.clone()));
        }
        let deadline = Instant::now() + timeout;
        let result = match &target {
            Target::IosSimulator(udid) => boot_simulator(udid, timeout),
            Target::AndroidAvd(name) => {
                let tools = probed.android.clone().unwrap_or_default();
                boot_avd(&tools, name, device.state == DeviceState::Booting, deadline).map(Some)
            }
            _ => Err(anyhow!("Device {} cannot be booted", boot.device_id)),
        };
        match result {
            Ok(serial) => self.device_finish(id, booted(false, serial)),
            // The boot may still finish; leave the receipt open for a replay.
            Err(error) if Instant::now() >= deadline => Err(error.context(format!(
                "Device {} did not finish booting before the deadline; repeat operation {id} to reconcile it",
                boot.device_id
            ))),
            Err(error) => self.device_finish(id, Err(error)),
        }
    }

    fn device_install(&self, request: &Value) -> Result<Value> {
        const OP: &str = "device.app.install";
        let install: DeviceAppInstallRequest = decode(request)?;
        let id = operation_id(&install.operation_id)?;
        let _claim = Claim::acquire(&install.device_id, id)?;
        let _host = HostClaim::acquire(self, &install.device_id, id)?;
        let (target, probed) = locate(&install.host_id, &install.device_id)?;
        let tools = probed.android.clone().unwrap_or_default();
        let installed = |app_id: String, version: String| {
            reply(&DeviceAppInstalled {
                tag: Default::default(),
                operation_id: install.operation_id.clone(),
                host_id: install.host_id.clone(),
                device_id: install.device_id.clone(),
                app_id,
                version,
            })
        };
        let observe = |app_id: &str| -> Result<Option<String>> {
            match &target {
                Target::IosSimulator(udid) => ios_installed_version(udid, app_id),
                _ => {
                    let device = probed
                        .devices
                        .iter()
                        .find(|device| device.device_id == install.device_id)
                        .context("The device is not attached now")?;
                    let serial = android_serial(&tools, device, &target)?;
                    android_installed_version(&tools, &serial, app_id)
                }
            }
        };
        let reconcile = |record: &Value| {
            let (Some(app_id), Some(version)) =
                (record["app_id"].as_str(), record["version"].as_str())
            else {
                return Reconciled::Unknown("the receipt does not name the app".into());
            };
            match observe(app_id) {
                Ok(found) if core::install_converged(found.as_deref(), version) => {
                    Reconciled::Settle(installed(app_id.into(), version.into()))
                }
                Ok(_) => Reconciled::Settle(Err(anyhow!(
                    "The install of {app_id} {version} was interrupted and the device does not report it; it was not retried"
                ))),
                Err(error) => Reconciled::Pending(format!(
                    "Operation {id} cannot be reconciled now: {error}; repeat it when the device is available"
                )),
            }
        };
        let admission = self.device_peek(id, OP, request)?;
        if admission != Admission::New {
            return self.device_replay(id, admission, reconcile);
        }
        let device = core::require(
            &probed.devices,
            &install.device_id,
            DeviceCapability::InstallApp,
        )?;
        let app = Path::new(&install.app_path);
        ensure!(
            app.is_absolute(),
            "app_path must be an absolute path on the device's host"
        );
        let path = install.app_path.as_str();
        let (app_id, version, serial) = match &target {
            Target::IosSimulator(_) => {
                ensure!(
                    app.extension().is_some_and(|ext| ext == "app") && app.is_dir(),
                    "app_path must be a built .app directory for a simulator"
                );
                let plist = app.join("Info.plist");
                let app_id = plist_value(&plist, "CFBundleIdentifier")?;
                ensure!(
                    core::is_bundle_id(&app_id),
                    "The app's bundle identifier is invalid"
                );
                (app_id, plist_value(&plist, "CFBundleVersion")?, None)
            }
            _ => {
                ensure!(
                    app.extension().is_some_and(|ext| ext == "apk") && app.is_file(),
                    "app_path must be an .apk file for an Android device"
                );
                let aapt = tools.aapt.as_deref().context("aapt2 was not found")?;
                let ran = run_ok(aapt, &["dump", "badging", path], LIST_TIMEOUT, TEXT_LIMIT)?;
                let (package, version) = core::parse_aapt_badging(&ran.text())?;
                (
                    package,
                    version,
                    Some(android_serial(&tools, device, &target)?),
                )
            }
        };
        let record = json!({"op": OP, "device_id": install.device_id, "app_id": app_id,
            "version": version});
        let admission = self.device_dispatch(id, OP, request, &record)?;
        if admission != Admission::New {
            return self.device_replay(id, admission, reconcile);
        }
        let ran = match (&target, &serial) {
            (Target::IosSimulator(udid), _) => simctl(&["install", udid, path], INSTALL_TIMEOUT),
            (_, Some(serial)) => confirm_serial(&tools, serial, &target).and_then(|()| {
                adb(
                    &tools,
                    &["-s", serial, "install", "-r", path],
                    INSTALL_TIMEOUT,
                    TEXT_LIMIT,
                )
            }),
            _ => Err(anyhow!("The device has no adb serial")),
        };
        let ran = match ran {
            Ok(ran) => ran,
            // A tool that timed out or could not be read may have installed.
            Err(error) => return self.device_unknown(id, error.to_string()),
        };
        if !ran.success {
            return self.device_finish(id, Err(anyhow!("Install failed: {}", ran.detail())));
        }
        let result = match observe(&app_id) {
            Ok(found) if core::install_converged(found.as_deref(), &version) => {
                installed(app_id, version)
            }
            Ok(found) => Err(anyhow!(
                "The install tool finished, but the device reports {app_id} at {} instead of {version}",
                found.as_deref().unwrap_or("no version")
            )),
            Err(error) => {
                return self.device_unknown(id, format!("install could not be verified: {error}"));
            }
        };
        self.device_finish(id, result)
    }

    fn device_launch(&self, request: &Value) -> Result<Value> {
        const OP: &str = "device.app.launch";
        let launch: DeviceAppLaunchRequest = decode(request)?;
        let id = operation_id(&launch.operation_id)?;
        let _claim = Claim::acquire(&launch.device_id, id)?;
        let _host = HostClaim::acquire(self, &launch.device_id, id)?;
        let admission = self.device_peek(id, OP, request)?;
        if admission != Admission::New {
            // Whether an interrupted launch happened is not observable.
            return self.device_replay(id, admission, |_| {
                Reconciled::Unknown(
                    "the launch was interrupted before its outcome was recorded".into(),
                )
            });
        }
        let (target, probed) = locate(&launch.host_id, &launch.device_id)?;
        let device = core::require(
            &probed.devices,
            &launch.device_id,
            DeviceCapability::LaunchApp,
        )?;
        let tools = probed.android.clone().unwrap_or_default();
        let app_id = launch.app_id.as_str();
        let launched = |pid: u64| {
            reply(&DeviceAppLaunched {
                tag: Default::default(),
                operation_id: launch.operation_id.clone(),
                host_id: launch.host_id.clone(),
                device_id: launch.device_id.clone(),
                app_id: launch.app_id.clone(),
                pid,
            })
        };
        let record = json!({"op": OP, "device_id": launch.device_id, "app_id": app_id});
        match &target {
            Target::IosSimulator(udid) => {
                ensure!(
                    core::is_bundle_id(app_id),
                    "app_id is not a bundle identifier"
                );
                ensure!(
                    ios_installed_version(udid, app_id)?.is_some(),
                    "{app_id} is not installed on {}",
                    launch.device_id
                );
                let admission = self.device_dispatch(id, OP, request, &record)?;
                if admission != Admission::New {
                    return self.device_replay(id, admission, |_| {
                        Reconciled::Unknown("a concurrent launch holds this receipt".into())
                    });
                }
                let ran = match simctl(&["launch", udid, app_id], LAUNCH_TIMEOUT) {
                    Ok(ran) => ran,
                    Err(error) => return self.device_unknown(id, error.to_string()),
                };
                if !ran.success {
                    return self.device_finish(id, Err(anyhow!("Launch failed: {}", ran.detail())));
                }
                match core::parse_simctl_launch(&ran.text(), app_id) {
                    Some(pid) => self.device_finish(id, launched(pid)),
                    None => self.device_unknown(id, "simctl reported no process ID".into()),
                }
            }
            _ => {
                ensure!(
                    core::is_package(app_id),
                    "app_id is not an Android package name"
                );
                let serial = android_serial(&tools, device, &target)?;
                ensure!(
                    android_installed_version(&tools, &serial, app_id)?.is_some(),
                    "{app_id} is not installed on {}",
                    launch.device_id
                );
                let resolved = adb(
                    &tools,
                    &[
                        "-s",
                        &serial,
                        "shell",
                        "cmd",
                        "package",
                        "resolve-activity",
                        "--brief",
                        "-a",
                        "android.intent.action.MAIN",
                        "-c",
                        "android.intent.category.LAUNCHER",
                        app_id,
                    ],
                    LIST_TIMEOUT,
                    64 * 1024,
                )?;
                let component = core::parse_resolved_activity(&resolved.text(), app_id)
                    .with_context(|| format!("{app_id} has no launcher activity"))?;
                let admission = self.device_dispatch(id, OP, request, &record)?;
                if admission != Admission::New {
                    return self.device_replay(id, admission, |_| {
                        Reconciled::Unknown("a concurrent launch holds this receipt".into())
                    });
                }
                let started = confirm_serial(&tools, &serial, &target).and_then(|()| {
                    adb(
                        &tools,
                        &[
                            "-s", &serial, "shell", "am", "start", "-W", "-n", &component,
                        ],
                        LAUNCH_TIMEOUT,
                        64 * 1024,
                    )
                });
                let started = match started {
                    Ok(ran) => ran,
                    Err(error) => return self.device_unknown(id, error.to_string()),
                };
                let text = started.text();
                if !started.success || text.contains("Error:") {
                    return self
                        .device_finish(id, Err(anyhow!("Launch failed: {}", started.detail())));
                }
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    let pid = adb(
                        &tools,
                        &["-s", &serial, "shell", "pidof", app_id],
                        LIST_TIMEOUT,
                        64 * 1024,
                    )
                    .ok()
                    .filter(|ran| ran.success)
                    .and_then(|ran| core::parse_pid(&ran.text()));
                    if let Some(pid) = pid {
                        return self.device_finish(id, launched(pid));
                    }
                    if Instant::now() >= deadline {
                        return self.device_unknown(
                            id,
                            "am start ran but no app process was observed".into(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        }
    }
}

fn boot_simulator(udid: &str, timeout: Duration) -> Result<Option<String>> {
    // `bootstatus -b` boots a shut-down simulator and waits until it is usable.
    let ran = simctl(&["bootstatus", udid, "-b"], timeout)?;
    ensure!(
        ran.success,
        "simctl could not boot the simulator: {}",
        ran.detail()
    );
    let state =
        core::parse_simctl_devices(&simctl(&["list", "devices", "-j"], LIST_TIMEOUT)?.text())?
            .into_iter()
            .find(|simulator| simulator.udid == udid)
            .map(|simulator| simulator.state);
    ensure!(
        state == Some(DeviceState::Booted),
        "simctl finished, but the simulator does not report booted"
    );
    Ok(None)
}

/// Starts an AVD (unless it is already starting) and waits for adb to report
/// it booted. Returns its serial.
fn boot_avd(tools: &AndroidTools, name: &str, starting: bool, deadline: Instant) -> Result<String> {
    use std::os::unix::process::CommandExt;
    if !starting {
        let emulator = tools
            .emulator
            .as_deref()
            .context("The Android emulator was not found")?;
        // The emulator outlives this request and the daemon; its own process
        // group keeps a daemon stop from signalling it.
        let mut child = Command::new(emulator)
            .args(["-avd", name])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .context("Could not start the Android emulator")?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(1));
        let Ok(running) = running_android(tools) else {
            continue;
        };
        if let Some(entry) = running
            .iter()
            .find(|entry| entry.avd.as_deref() == Some(name) && entry.boot_completed)
        {
            return Ok(entry.device.serial.clone());
        }
    }
    bail!("AVD {name} did not finish booting in time")
}
