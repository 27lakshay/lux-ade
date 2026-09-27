//! Pure device core (F098–F100, D12): device identities, tool-output parsers,
//! availability classification and receipt reconciliation decisions.
//!
//! Nothing here runs a process or reads the host. `sessions::devices` gathers
//! the facts (tool output, permission answers, display lists) and hands them to
//! these functions, so every decision is testable over sample output.
//!
//! Portions adapted from Orca `src/main/emulator/simctl-simulator-devices.ts`,
//! `src/main/emulator/android/adb-devices.ts`, `avd-manager.ts`,
//! `android-sdk-discovery.ts` and `android-device-inventory.ts` (MIT, Copyright
//! (c) 2026 Lovecast Inc.): the simctl JSON shape, the `adb devices -l` line
//! grammar, the `emulator -list-avds` noise filter and the SDK root order.
use ade_core::contract::devices::{
    DeviceCapability, DeviceCapabilityStatus, DeviceFamily, DeviceFamilyStatus, DeviceInputAction,
    DeviceKey, DeviceKind, DevicePermission, DevicePermissionState, DevicePermissionStatus,
    DeviceReason, DeviceReasonCode, DeviceState, DeviceSummary,
};
use ade_core::contract::orchestration::Caller;
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The largest screenshot the daemon returns, before base64.
pub const MAX_SCREENSHOT_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_BOOT_TIMEOUT_MS: u64 = 120_000;
pub const MIN_BOOT_TIMEOUT_MS: u64 = 5_000;
pub const MAX_BOOT_TIMEOUT_MS: u64 = 300_000;

/// Who the macOS permission answers describe.
pub const PERMISSION_SUBJECT: &str =
    "ade-daemon process; macOS attributes it to the application that launched the daemon";

/// A parsed stable device identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Display(String),
    IosSimulator(String),
    AndroidAvd(String),
    AndroidSerial(String),
}

impl Target {
    pub fn parse(device_id: &str) -> Result<Self> {
        let (scheme, value) = device_id
            .split_once(':')
            .with_context(|| format!("Device ID {device_id:?} has no kind prefix"))?;
        let target = match scheme {
            "display" if is_uuid(value) => Self::Display(value.to_ascii_uppercase()),
            "ios-sim" if is_uuid(value) => Self::IosSimulator(value.to_ascii_uppercase()),
            "android-avd" if is_avd_name(value) => Self::AndroidAvd(value.to_owned()),
            "android-serial" if is_serial(value) => Self::AndroidSerial(value.to_owned()),
            _ => bail!("Device ID {device_id:?} is not a device identity from device.list"),
        };
        Ok(target)
    }

    pub fn family(&self) -> DeviceFamily {
        match self {
            Self::Display(_) => DeviceFamily::Computer,
            Self::IosSimulator(_) => DeviceFamily::IosSimulator,
            Self::AndroidAvd(_) | Self::AndroidSerial(_) => DeviceFamily::Android,
        }
    }

    pub fn id(&self) -> String {
        match self {
            Self::Display(uuid) => format!("display:{uuid}"),
            Self::IosSimulator(udid) => format!("ios-sim:{udid}"),
            Self::AndroidAvd(name) => format!("android-avd:{name}"),
            Self::AndroidSerial(serial) => format!("android-serial:{serial}"),
        }
    }
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// AVD names are letters, digits, `.`, `_` and `-` (the AVD manager's rule).
fn is_avd_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// adb serials are printable without whitespace; `host:port` for network devices.
fn is_serial(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('-')
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

/// Reads `IOPlatformUUID` from `ioreg -rd1 -c IOPlatformExpertDevice`.
pub fn parse_ioreg_platform_uuid(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("\"IOPlatformUUID\"")?;
        let value = rest.trim().strip_prefix('=')?.trim().trim_matches('"');
        is_uuid(value).then(|| value.to_ascii_uppercase())
    })
}

/// A host identity that never exposes the machine identifier it derives from.
pub fn host_id(machine_id: &str) -> String {
    let digest = Sha256::digest(format!("ade-host-v1\0{}", machine_id.trim()).as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("host-{hex}")
}

/// Refuses a request aimed at another host. Device control is never relayed.
pub fn require_host(own: &str, requested: &str) -> Result<()> {
    ensure!(
        own == requested,
        "Device host {requested} is not this daemon's host {own}; ADE controls devices only on the host that owns them"
    );
    Ok(())
}

// ---- iOS simulators -------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Simulator {
    pub udid: String,
    pub name: String,
    pub state: DeviceState,
    pub runtime: String,
    pub available: bool,
    pub availability_error: Option<String>,
}

const IOS_RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.iOS-";

/// Parses `xcrun simctl list devices -j`, keeping iOS runtimes only.
pub fn parse_simctl_devices(json: &str) -> Result<Vec<Simulator>> {
    let value: Value =
        serde_json::from_str(json).context("xcrun simctl returned invalid device JSON")?;
    let runtimes = value["devices"]
        .as_object()
        .context("xcrun simctl device JSON has no devices map")?;
    let mut simulators = Vec::new();
    for (runtime, devices) in runtimes {
        let Some(version) = runtime.strip_prefix(IOS_RUNTIME) else {
            continue;
        };
        for device in devices.as_array().into_iter().flatten() {
            let Some(udid) = device["udid"].as_str().filter(|udid| is_uuid(udid)) else {
                continue;
            };
            simulators.push(Simulator {
                udid: udid.to_ascii_uppercase(),
                name: device["name"].as_str().unwrap_or(udid).to_owned(),
                state: simctl_state(device["state"].as_str().unwrap_or("")),
                runtime: format!("iOS {}", version.replace('-', ".")),
                // An absent flag is not proof of availability.
                available: device["isAvailable"].as_bool() == Some(true),
                availability_error: device["availabilityError"].as_str().map(str::to_owned),
            });
        }
    }
    simulators.sort_by(|a, b| (&a.runtime, &a.name, &a.udid).cmp(&(&b.runtime, &b.name, &b.udid)));
    Ok(simulators)
}

pub fn simctl_state(state: &str) -> DeviceState {
    match state {
        "Booted" => DeviceState::Booted,
        "Booting" => DeviceState::Booting,
        "Shutdown" => DeviceState::Shutdown,
        "Shutting Down" => DeviceState::ShuttingDown,
        _ => DeviceState::Unknown,
    }
}

/// Whether `xcrun` output says Simulator tools are not installed or selected.
pub fn simctl_missing(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    (lower.contains("unable to find utility") && lower.contains("simctl"))
        || lower.contains("not a developer tool")
        || lower.contains("invalid active developer path")
        || lower.contains("xcode-select: error")
}

/// Reads the process ID from `xcrun simctl launch` (`<bundle>: <pid>`).
pub fn parse_simctl_launch(stdout: &str, bundle: &str) -> Option<u64> {
    stdout.lines().find_map(|line| {
        let (name, pid) = line.trim().rsplit_once(':')?;
        (name.trim() == bundle).then_some(())?;
        pid.trim().parse().ok().filter(|pid| *pid > 0)
    })
}

/// A plist value printed by `plutil -extract KEY raw`.
pub fn parse_plist_raw(stdout: &str, key: &str) -> Result<String> {
    let value = stdout.trim();
    ensure!(
        !value.is_empty() && !value.contains('\n') && value.len() <= 256,
        "The app's Info.plist has no usable {key}"
    );
    Ok(value.to_owned())
}

// ---- Android ---------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdbDevice {
    pub serial: String,
    /// `device`, `offline`, `unauthorized`, `no permissions`, `bootloader`, ...
    pub state: String,
    pub model: Option<String>,
}

impl AdbDevice {
    pub fn is_emulator(&self) -> bool {
        self.serial.starts_with("emulator-")
    }
}

/// Parses `adb devices -l`.
pub fn parse_adb_devices(stdout: &str) -> Vec<AdbDevice> {
    let mut devices = Vec::new();
    for line in stdout.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(serial) = tokens.first().filter(|serial| is_serial(serial)) else {
            continue;
        };
        // `no permissions` is the one two-word state adb prints.
        let (state, rest) = if tokens.get(1) == Some(&"no") && tokens.get(2) == Some(&"permissions")
        {
            ("no permissions".to_owned(), 3)
        } else {
            (tokens.get(1).copied().unwrap_or("").to_owned(), 2)
        };
        let model = tokens
            .iter()
            .skip(rest)
            .find_map(|token| token.strip_prefix("model:"))
            .map(str::to_owned);
        devices.push(AdbDevice {
            serial: (*serial).to_owned(),
            state,
            model,
        });
    }
    devices
}

/// Parses `emulator -list-avds`, dropping the emulator's log lines.
pub fn parse_avd_list(stdout: &str) -> Vec<String> {
    let mut names: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| {
            let log = ["INFO", "WARNING", "ERROR", "DEBUG", "VERBOSE", "PANIC"]
                .iter()
                .any(|level| {
                    line.strip_prefix(level)
                        .is_some_and(|rest| rest.starts_with(char::is_whitespace))
                });
            !log && is_avd_name(line)
        })
        .map(str::to_owned)
        .collect();
    names.sort();
    names.dedup();
    names
}

/// `adb -s SERIAL emu avd name` prints the AVD name, then `OK`.
pub fn parse_emu_avd_name(stdout: &str) -> Option<String> {
    let mut lines = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let name = lines.next()?;
    (is_avd_name(name) && name != "OK" && lines.next() == Some("OK")).then(|| name.to_owned())
}

/// `getprop sys.boot_completed` prints `1` once Android is up.
pub fn boot_completed(stdout: &str) -> bool {
    stdout.trim() == "1"
}

/// The package name and version code from `aapt2 dump badging` (or `aapt`).
pub fn parse_aapt_badging(stdout: &str) -> Result<(String, String)> {
    let line = stdout
        .lines()
        .find(|line| line.starts_with("package:"))
        .context("The APK has no package line; it may not be an APK")?;
    let field = |key: &str| -> Option<String> {
        let start = line.find(&format!(" {key}='"))? + key.len() + 3;
        let end = line[start..].find('\'')? + start;
        Some(line[start..end].to_owned())
    };
    let package = field("name").filter(|name| is_package(name));
    let version = field("versionCode").filter(|code| is_digits(code));
    match (package, version) {
        (Some(package), Some(version)) => Ok((package, version)),
        _ => bail!("The APK's package name or version code could not be read"),
    }
}

pub fn is_package(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.contains('.')
        && !value.starts_with('.')
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_'))
}

/// Bundle identifiers: letters, digits, `.` and `-`.
pub fn is_bundle_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// The installed version code of `package` from `dumpsys package PACKAGE`.
pub fn parse_dumpsys_version_code(stdout: &str, package: &str) -> Option<String> {
    let marker = format!("Package [{package}]");
    let start = stdout.find(&marker)?;
    let rest = &stdout[start..];
    let at = rest.find("versionCode=")? + "versionCode=".len();
    let code: String = rest[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    (!code.is_empty()).then_some(code)
}

/// The launcher component from `cmd package resolve-activity --brief`.
pub fn parse_resolved_activity(stdout: &str, package: &str) -> Option<String> {
    let line = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())?;
    let (owner, activity) = line.split_once('/')?;
    // The component is passed through the device shell, so it keeps to
    // characters the shell treats literally.
    let literal = activity
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_'));
    (owner == package && !activity.is_empty() && literal).then(|| line.to_owned())
}

/// The first process ID from `pidof`.
pub fn parse_pid(stdout: &str) -> Option<u64> {
    stdout
        .split_whitespace()
        .next()?
        .parse()
        .ok()
        .filter(|pid| *pid > 0)
}

/// Where to look for an Android SDK, in order.
pub fn sdk_roots(
    android_home: Option<&str>,
    android_sdk_root: Option<&str>,
    home: Option<&Path>,
    macos: bool,
) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = [android_home, android_sdk_root]
        .into_iter()
        .flatten()
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .collect();
    if let Some(home) = home {
        roots.push(if macos {
            home.join("Library/Android/sdk")
        } else {
            home.join("Android/Sdk")
        });
    }
    roots.dedup();
    roots
}

/// The newest build-tools version directory name.
pub fn newest_build_tools(names: &[String]) -> Option<String> {
    let key = |name: &str| -> Option<Vec<u64>> {
        name.split(['.', '-'])
            .map(|part| part.parse().ok())
            .collect::<Option<Vec<_>>>()
    };
    names
        .iter()
        .filter_map(|name| key(name).map(|version| (version, name)))
        .max()
        .map(|(_, name)| name.clone())
}

// ---- Computer ----------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Display {
    pub uuid: String,
    /// The display's size in points.
    pub width: u64,
    pub height: u64,
    pub main: bool,
    pub builtin: bool,
}

/// Width and height from a PNG's IHDR chunk.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u64, u64)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (width > 0 && height > 0).then_some((u64::from(width), u64::from(height)))
}

/// Whether a capture is the whole display at an integer backing scale.
pub fn png_matches_display(png: (u64, u64), display: &Display) -> bool {
    let (width, height) = png;
    if display.width == 0 || display.height == 0 {
        return false;
    }
    width % display.width == 0
        && height % display.height == 0
        && width / display.width == height / display.height
        && (1..=4).contains(&(width / display.width))
}

// ---- Classification ------------------------------------------------------------

fn reason(code: DeviceReasonCode, detail: impl Into<String>) -> DeviceReason {
    DeviceReason {
        code,
        detail: detail.into(),
    }
}

fn capability(
    capability: DeviceCapability,
    blocked: Option<DeviceReason>,
) -> DeviceCapabilityStatus {
    DeviceCapabilityStatus {
        capability,
        available: blocked.is_none(),
        reason: blocked,
    }
}

/// What the macOS permission checks answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Permissions {
    pub screen_recording: DevicePermissionState,
    pub accessibility: DevicePermissionState,
}

/// The computer family: the host's displays and screen permissions.
pub fn classify_computer(
    macos: bool,
    permissions: Permissions,
    displays: Result<Vec<Display>, String>,
) -> (DeviceFamilyStatus, Vec<DeviceSummary>) {
    let permission_list = vec![
        DevicePermissionStatus {
            permission: DevicePermission::ScreenRecording,
            state: permissions.screen_recording,
            subject: PERMISSION_SUBJECT.into(),
        },
        DevicePermissionStatus {
            permission: DevicePermission::Accessibility,
            state: permissions.accessibility,
            subject: PERMISSION_SUBJECT.into(),
        },
    ];
    let mut reasons = Vec::new();
    if !macos {
        reasons.push(reason(
            DeviceReasonCode::PlatformUnsupported,
            "Screen access is implemented for macOS hosts only",
        ));
        let status = DeviceFamilyStatus {
            family: DeviceFamily::Computer,
            available: false,
            reasons,
            tools: vec![],
            permissions: permission_list,
        };
        return (status, vec![]);
    }
    let screen_denied = permissions.screen_recording != DevicePermissionState::Granted;
    if screen_denied {
        reasons.push(reason(
            DeviceReasonCode::PermissionDenied,
            "Screen Recording is not granted. Allow it in System Settings > Privacy & Security > Screen Recording, then restart ADE",
        ));
    }
    if permissions.accessibility != DevicePermissionState::Granted {
        reasons.push(reason(
            DeviceReasonCode::PermissionDenied,
            "Accessibility is not granted. Input control will need it in System Settings > Privacy & Security > Accessibility",
        ));
    }
    let displays = match displays {
        Ok(displays) => displays,
        Err(error) => {
            reasons.push(reason(DeviceReasonCode::ToolFailed, error));
            vec![]
        }
    };
    let several = displays.len() > 1;
    // Posting events to a display would act on whatever window has focus,
    // so ADE does not offer it; nothing is ever redirected to the focused app.
    let display_input = if permissions.accessibility != DevicePermissionState::Granted {
        reason(
            DeviceReasonCode::PermissionDenied,
            "Accessibility is not granted",
        )
    } else {
        reason(
            DeviceReasonCode::NotSupported,
            "Input to a display or application is not built; ADE never sends input to whatever has focus",
        )
    };
    let devices: Vec<DeviceSummary> = displays
        .iter()
        .map(|display| {
            let blocked = if screen_denied {
                Some(reason(
                    DeviceReasonCode::PermissionDenied,
                    "Screen Recording is not granted",
                ))
            } else if several {
                Some(reason(
                    DeviceReasonCode::TargetUnverified,
                    "With more than one display attached, ADE cannot yet prove a capture comes from this display",
                ))
            } else {
                None
            };
            DeviceSummary {
                device_id: Target::Display(display.uuid.clone()).id(),
                family: DeviceFamily::Computer,
                kind: DeviceKind::Display,
                name: match (display.builtin, display.main) {
                    (true, _) => "Built-in display".into(),
                    (false, true) => "Main display".into(),
                    (false, false) => "Display".into(),
                },
                state: DeviceState::Connected,
                runtime: None,
                serial: None,
                capabilities: vec![
                    capability(DeviceCapability::Screenshot, blocked),
                    capability(DeviceCapability::Input, Some(display_input.clone())),
                ],
            }
        })
        .collect();
    let available = !screen_denied && !devices.is_empty();
    let status = DeviceFamilyStatus {
        family: DeviceFamily::Computer,
        available,
        reasons,
        tools: vec![],
        permissions: permission_list,
    };
    (status, devices)
}

/// What probing the iOS simulator tools found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IosProbe {
    NotMacos,
    /// `xcrun` is absent or Simulator tools are not selected.
    ToolMissing(String),
    ToolFailed(String),
    Listed {
        xcrun: String,
        /// `idb`, which sends simulator input; simctl cannot.
        idb: Option<String>,
        simulators: Vec<Simulator>,
    },
}

pub fn classify_ios(probe: IosProbe) -> (DeviceFamilyStatus, Vec<DeviceSummary>) {
    let family = |available, reasons, tools| DeviceFamilyStatus {
        family: DeviceFamily::IosSimulator,
        available,
        reasons,
        tools,
        permissions: vec![],
    };
    let (xcrun, idb, simulators) = match probe {
        IosProbe::NotMacos => {
            let why = reason(
                DeviceReasonCode::PlatformUnsupported,
                "iOS simulators need a macOS host with Xcode",
            );
            return (family(false, vec![why], vec![]), vec![]);
        }
        IosProbe::ToolMissing(detail) => {
            let why = reason(DeviceReasonCode::ToolMissing, detail);
            return (family(false, vec![why], vec![]), vec![]);
        }
        IosProbe::ToolFailed(detail) => {
            let why = reason(DeviceReasonCode::ToolFailed, detail);
            return (family(false, vec![why], vec![]), vec![]);
        }
        IosProbe::Listed {
            xcrun,
            idb,
            simulators,
        } => (xcrun, idb, simulators),
    };
    let mut reasons = Vec::new();
    if simulators.is_empty() {
        reasons.push(reason(
            DeviceReasonCode::RuntimeMissing,
            "No iOS simulators exist. Add an iOS platform in Xcode > Settings > Components",
        ));
    } else if simulators.iter().all(|simulator| !simulator.available) {
        reasons.push(reason(
            DeviceReasonCode::RuntimeMissing,
            "No iOS simulator has an installed runtime. Install one in Xcode > Settings > Components",
        ));
    }
    let devices: Vec<DeviceSummary> = simulators
        .iter()
        .map(|simulator| ios_summary(simulator, idb.is_some()))
        .collect();
    let available = simulators.iter().any(|simulator| simulator.available);
    let tools = std::iter::once(xcrun).chain(idb).collect();
    (family(available, reasons, tools), devices)
}

fn ios_summary(simulator: &Simulator, idb: bool) -> DeviceSummary {
    use DeviceCapability::*;
    let missing = (!simulator.available).then(|| {
        reason(
            DeviceReasonCode::RuntimeMissing,
            simulator
                .availability_error
                .clone()
                .unwrap_or_else(|| "The simulator's runtime is unavailable".into()),
        )
    });
    let not_booted = || {
        reason(
            DeviceReasonCode::DeviceNotBooted,
            "Boot the simulator first",
        )
    };
    let booting = || {
        reason(
            DeviceReasonCode::DeviceBooting,
            "The simulator is changing state",
        )
    };
    let capabilities = [Boot, Screenshot, InstallApp, LaunchApp, Input]
        .into_iter()
        .map(|kind| {
            let blocked = missing.clone().or(match (simulator.state, kind) {
                (_, Input) if !idb => Some(reason(
                    DeviceReasonCode::ToolMissing,
                    "Simulator input needs idb (brew install idb-companion, pipx install fb-idb); simctl cannot send touches",
                )),
                (DeviceState::Shutdown, Boot) => None,
                (DeviceState::Booted, Boot) => Some(reason(
                    DeviceReasonCode::DeviceBooted,
                    "The simulator is already booted",
                )),
                (DeviceState::Booted, _) => None,
                (DeviceState::Shutdown, _) => Some(not_booted()),
                (DeviceState::Booting | DeviceState::ShuttingDown, _) => Some(booting()),
                _ => Some(reason(
                    DeviceReasonCode::ToolFailed,
                    "simctl reported an unknown simulator state",
                )),
            });
            capability(kind, blocked)
        })
        .collect();
    DeviceSummary {
        device_id: Target::IosSimulator(simulator.udid.clone()).id(),
        family: DeviceFamily::IosSimulator,
        kind: DeviceKind::Simulator,
        name: simulator.name.clone(),
        state: simulator.state,
        runtime: Some(simulator.runtime.clone()),
        serial: None,
        capabilities,
    }
}

/// The Android SDK tools the adapter found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AndroidTools {
    pub adb: Option<PathBuf>,
    pub emulator: Option<PathBuf>,
    /// `aapt2` or `aapt`, needed to read an APK's package before installing it.
    pub aapt: Option<PathBuf>,
}

/// One running adb device with what the adapter learned about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunningAndroid {
    pub device: AdbDevice,
    /// The AVD name of an emulator, from `emu avd name`.
    pub avd: Option<String>,
    /// `sys.boot_completed`, when adb could ask.
    pub boot_completed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AndroidProbe {
    pub tools: AndroidTools,
    pub running: Result<Vec<RunningAndroid>, String>,
    /// `emulator -list-avds`; `Ok(empty)` when the emulator tool is absent.
    pub avds: Result<Vec<String>, String>,
}

pub fn classify_android(probe: AndroidProbe) -> (DeviceFamilyStatus, Vec<DeviceSummary>) {
    let AndroidProbe {
        tools,
        running,
        avds,
    } = probe;
    let mut reasons = Vec::new();
    let paths: Vec<String> = [&tools.adb, &tools.emulator, &tools.aapt]
        .into_iter()
        .flatten()
        .map(|path| path.display().to_string())
        .collect();
    if tools.adb.is_none() {
        reasons.push(reason(
            DeviceReasonCode::ToolMissing,
            "adb was not found. Install the Android SDK platform-tools or set ANDROID_HOME",
        ));
    }
    if tools.emulator.is_none() {
        reasons.push(reason(
            DeviceReasonCode::ToolMissing,
            "The Android emulator was not found; AVDs cannot be listed or booted",
        ));
    }
    if tools.aapt.is_none() {
        reasons.push(reason(
            DeviceReasonCode::ToolMissing,
            "Android SDK build-tools (aapt2) were not found; APKs cannot be installed",
        ));
    }
    let running = match running {
        Ok(running) => running,
        Err(error) => {
            reasons.push(reason(DeviceReasonCode::ToolFailed, error));
            vec![]
        }
    };
    let avds = match avds {
        Ok(avds) => avds,
        Err(error) => {
            reasons.push(reason(DeviceReasonCode::ToolFailed, error));
            vec![]
        }
    };
    let mut devices = Vec::new();
    let mut booted_avds = HashMap::new();
    for entry in &running {
        let summary = android_running_summary(entry, &tools);
        if let Some(avd) = &entry.avd {
            booted_avds.insert(avd.clone(), ());
        }
        devices.push(summary);
    }
    for avd in avds {
        if booted_avds.contains_key(&avd) {
            continue;
        }
        use DeviceCapability::*;
        let not_booted = || reason(DeviceReasonCode::DeviceNotBooted, "Boot the AVD first");
        let boot = if tools.emulator.is_none() {
            Some(reason(
                DeviceReasonCode::ToolMissing,
                "The Android emulator was not found",
            ))
        } else if tools.adb.is_none() {
            Some(reason(
                DeviceReasonCode::ToolMissing,
                "adb is needed to confirm the AVD finished booting",
            ))
        } else {
            None
        };
        devices.push(DeviceSummary {
            device_id: Target::AndroidAvd(avd.clone()).id(),
            family: DeviceFamily::Android,
            kind: DeviceKind::Emulator,
            name: avd.clone(),
            state: DeviceState::Shutdown,
            runtime: Some(avd),
            serial: None,
            capabilities: vec![
                capability(Boot, boot),
                capability(Screenshot, Some(not_booted())),
                capability(InstallApp, Some(not_booted())),
                capability(LaunchApp, Some(not_booted())),
                capability(Input, Some(not_booted())),
            ],
        });
    }
    devices.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    let available = tools.adb.is_some() && !devices.is_empty();
    if tools.adb.is_some() && devices.is_empty() {
        reasons.push(reason(
            DeviceReasonCode::RuntimeMissing,
            "No Android device is connected and no AVD exists",
        ));
    }
    let status = DeviceFamilyStatus {
        family: DeviceFamily::Android,
        available,
        reasons,
        tools: paths,
        permissions: vec![],
    };
    (status, devices)
}

fn android_running_summary(entry: &RunningAndroid, tools: &AndroidTools) -> DeviceSummary {
    use DeviceCapability::*;
    let device = &entry.device;
    let state = match device.state.as_str() {
        "device" if entry.boot_completed => DeviceState::Booted,
        "device" => DeviceState::Booting,
        "offline" => DeviceState::Offline,
        "unauthorized" | "authorizing" => DeviceState::Unauthorized,
        "no permissions" => DeviceState::NoPermissions,
        _ => DeviceState::Unknown,
    };
    let blocked = match state {
        DeviceState::Booted => None,
        DeviceState::Booting => Some(reason(
            DeviceReasonCode::DeviceBooting,
            "Android has not finished booting",
        )),
        DeviceState::Offline => Some(reason(
            DeviceReasonCode::DeviceOffline,
            "adb reports the device offline",
        )),
        DeviceState::Unauthorized => Some(reason(
            DeviceReasonCode::DeviceUnauthorized,
            "Accept this computer's USB debugging key on the device",
        )),
        DeviceState::NoPermissions => Some(reason(
            DeviceReasonCode::DeviceNoPermissions,
            "The host user lacks USB permission for this device",
        )),
        _ => Some(reason(
            DeviceReasonCode::ToolFailed,
            format!("adb reports the device state {:?}", device.state),
        )),
    };
    let emulator = device.is_emulator();
    let boot = if !emulator {
        Some(reason(
            DeviceReasonCode::NotSupported,
            "ADE does not boot physical devices",
        ))
    } else if entry.avd.is_none() {
        Some(reason(
            DeviceReasonCode::TargetUnverified,
            "The emulator's AVD name could not be read",
        ))
    } else {
        Some(reason(
            DeviceReasonCode::DeviceBooted,
            "The AVD is already running",
        ))
    };
    let install = blocked.clone().or_else(|| {
        tools.aapt.is_none().then(|| {
            reason(
                DeviceReasonCode::ToolMissing,
                "Android SDK build-tools (aapt2) are needed to read the APK",
            )
        })
    });
    let device_id = match &entry.avd {
        Some(avd) => Target::AndroidAvd(avd.clone()).id(),
        None => Target::AndroidSerial(device.serial.clone()).id(),
    };
    DeviceSummary {
        device_id,
        family: DeviceFamily::Android,
        kind: if emulator {
            DeviceKind::Emulator
        } else {
            DeviceKind::Physical
        },
        name: entry
            .avd
            .clone()
            .or_else(|| device.model.clone())
            .unwrap_or_else(|| device.serial.clone()),
        state,
        runtime: entry.avd.clone(),
        serial: Some(device.serial.clone()),
        capabilities: vec![
            capability(Boot, boot),
            capability(Screenshot, blocked.clone()),
            capability(InstallApp, install),
            capability(LaunchApp, blocked.clone()),
            capability(Input, blocked),
        ],
    }
}

/// Finds the exact device and confirms it can take `wanted` now. Never
/// substitutes another device.
pub fn require<'a>(
    devices: &'a [DeviceSummary],
    device_id: &str,
    wanted: DeviceCapability,
) -> Result<&'a DeviceSummary> {
    let device = devices
        .iter()
        .find(|device| device.device_id == device_id)
        .with_context(|| {
            format!("Device {device_id} is unavailable: it is not attached to this host now")
        })?;
    let status = device
        .capabilities
        .iter()
        .find(|status| status.capability == wanted)
        .with_context(|| {
            format!("Device {device_id} is unavailable: it does not support {wanted:?}")
        })?;
    if let Some(blocked) = status.reason.as_ref().filter(|_| !status.available) {
        bail!(
            "Device {device_id} is unavailable ({}): {}",
            serde_json::to_value(blocked.code)
                .ok()
                .and_then(|code| code.as_str().map(str::to_owned))
                .unwrap_or_default(),
            blocked.detail
        );
    }
    Ok(device)
}

/// What an open `device.boot` receipt from an earlier daemon process means,
/// given the device's state now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BootReplay {
    /// The device is booted; the boot converged.
    Booted,
    /// Keep the receipt open; the caller retries the same ID later.
    StillBooting,
    /// The boot did not take effect. It is not retried.
    NotBooted,
}

pub fn decide_boot_replay(state: Option<DeviceState>) -> BootReplay {
    match state {
        Some(DeviceState::Booted) => BootReplay::Booted,
        Some(DeviceState::Booting) => BootReplay::StillBooting,
        _ => BootReplay::NotBooted,
    }
}

/// Whether an interrupted install converged: the device reports the app at
/// the version recorded when the install was dispatched.
pub fn install_converged(installed_version: Option<&str>, expected: &str) -> bool {
    installed_version == Some(expected)
}

/// The boot deadline a request asks for, within bounds.
pub fn boot_timeout(requested: Option<u64>) -> Result<u64> {
    let timeout = requested.unwrap_or(DEFAULT_BOOT_TIMEOUT_MS);
    ensure!(
        (MIN_BOOT_TIMEOUT_MS..=MAX_BOOT_TIMEOUT_MS).contains(&timeout),
        "timeout_ms must be between {MIN_BOOT_TIMEOUT_MS} and {MAX_BOOT_TIMEOUT_MS}"
    );
    Ok(timeout)
}

// ---- Input ---------------------------------------------------------------------

/// The largest coordinate `device.input` accepts.
pub const MAX_INPUT_COORDINATE: u32 = 100_000;
pub const MAX_INPUT_TEXT: usize = 1_000;
const DEFAULT_SWIPE_MS: u32 = 300;

/// The recorded attribution of an input: `user` or `agent:<conversation ID>`.
pub fn input_attribution(caller: &Caller) -> Result<String> {
    Ok(match caller {
        Caller::User => "user".into(),
        Caller::Agent { conversation_id } => {
            ensure!(
                !conversation_id.is_empty()
                    && conversation_id.len() <= 128
                    && conversation_id.bytes().all(|byte| byte.is_ascii_graphic()),
                "caller conversation_id is invalid"
            );
            format!("agent:{conversation_id}")
        }
    })
}

/// Checks an input event's bounds before anything is recorded or sent.
pub fn validate_input(action: &DeviceInputAction) -> Result<()> {
    let point = |x: u32, y: u32| {
        ensure!(
            x <= MAX_INPUT_COORDINATE && y <= MAX_INPUT_COORDINATE,
            "Input coordinates must be at most {MAX_INPUT_COORDINATE}"
        );
        Ok(())
    };
    match action {
        DeviceInputAction::Tap { x, y } => point(*x, *y),
        DeviceInputAction::Swipe {
            from_x,
            from_y,
            to_x,
            to_y,
            duration_ms,
        } => {
            point(*from_x, *from_y)?;
            point(*to_x, *to_y)?;
            ensure!(
                duration_ms.is_none_or(|ms| (1..=10_000).contains(&ms)),
                "duration_ms must be between 1 and 10000"
            );
            Ok(())
        }
        DeviceInputAction::Text { text } => {
            ensure!(
                !text.is_empty() && text.len() <= MAX_INPUT_TEXT,
                "Input text must be 1 to {MAX_INPUT_TEXT} characters"
            );
            ensure!(
                text.bytes().all(|byte| (0x20..=0x7e).contains(&byte)),
                "Input text must be printable ASCII"
            );
            Ok(())
        }
        DeviceInputAction::Key { .. } => Ok(()),
    }
}

/// The `adb shell` words for one input event. adb joins them into one
/// command line for the device's shell, so text is single-quoted and its
/// spaces become `%s`, which `input text` reads as a space.
pub fn android_input_args(action: &DeviceInputAction) -> Result<Vec<String>> {
    validate_input(action)?;
    let words = |items: &[&str]| items.iter().map(|word| (*word).to_owned()).collect();
    Ok(match action {
        DeviceInputAction::Tap { x, y } => words(&["input", "tap", &x.to_string(), &y.to_string()]),
        DeviceInputAction::Swipe {
            from_x,
            from_y,
            to_x,
            to_y,
            duration_ms,
        } => words(&[
            "input",
            "swipe",
            &from_x.to_string(),
            &from_y.to_string(),
            &to_x.to_string(),
            &to_y.to_string(),
            &duration_ms.unwrap_or(DEFAULT_SWIPE_MS).to_string(),
        ]),
        DeviceInputAction::Text { text } => {
            // `input text` has no escape for a literal `%s`.
            ensure!(
                !text.contains("%s"),
                "Android input text cannot contain \"%s\""
            );
            let quoted = format!("'{}'", text.replace('\'', "'\\''").replace(' ', "%s"));
            words(&["input", "text", &quoted])
        }
        DeviceInputAction::Key { key } => {
            let code = match key {
                DeviceKey::Home => "KEYCODE_HOME",
                DeviceKey::Back => "KEYCODE_BACK",
                DeviceKey::Enter => "KEYCODE_ENTER",
                DeviceKey::Delete => "KEYCODE_DEL",
                DeviceKey::Tab => "KEYCODE_TAB",
                DeviceKey::Escape => "KEYCODE_ESCAPE",
            };
            words(&["input", "keyevent", code])
        }
    })
}

/// The `idb` arguments for one input event to simulator `udid`. idb runs
/// without a shell, so text passes through as one argument.
pub fn idb_input_args(action: &DeviceInputAction, udid: &str) -> Result<Vec<String>> {
    validate_input(action)?;
    let mut args: Vec<String> = match action {
        DeviceInputAction::Tap { x, y } => {
            vec!["ui".into(), "tap".into(), x.to_string(), y.to_string()]
        }
        DeviceInputAction::Swipe {
            from_x,
            from_y,
            to_x,
            to_y,
            duration_ms,
        } => vec![
            "ui".into(),
            "swipe".into(),
            from_x.to_string(),
            from_y.to_string(),
            to_x.to_string(),
            to_y.to_string(),
            "--duration".into(),
            format!(
                "{:.3}",
                f64::from(duration_ms.unwrap_or(DEFAULT_SWIPE_MS)) / 1000.0
            ),
        ],
        DeviceInputAction::Text { text } => vec!["ui".into(), "text".into(), text.clone()],
        DeviceInputAction::Key {
            key: DeviceKey::Home,
        } => {
            vec!["ui".into(), "button".into(), "HOME".into()]
        }
        DeviceInputAction::Key {
            key: DeviceKey::Back,
        } => {
            bail!("An iOS simulator has no Back key")
        }
        // USB HID keyboard usage IDs.
        DeviceInputAction::Key { key } => {
            let code = match key {
                DeviceKey::Enter => 40,
                DeviceKey::Escape => 41,
                DeviceKey::Delete => 42,
                _ => 43,
            };
            vec!["ui".into(), "key".into(), code.to_string()]
        }
    };
    args.extend(["--udid".into(), udid.to_owned()]);
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_is_bounded_attributed_and_quoted_for_each_tool() {
        use DeviceInputAction::*;
        assert_eq!(input_attribution(&Caller::User).unwrap(), "user");
        let agent = Caller::Agent {
            conversation_id: "c1".into(),
        };
        assert_eq!(input_attribution(&agent).unwrap(), "agent:c1");
        let bad = Caller::Agent {
            conversation_id: "a b".into(),
        };
        assert!(input_attribution(&bad).is_err());

        assert!(validate_input(&Tap { x: 100_001, y: 0 }).is_err());
        assert!(
            validate_input(&Text {
                text: String::new()
            })
            .is_err()
        );
        assert!(validate_input(&Text { text: "é".into() }).is_err());
        assert!(
            validate_input(&Text {
                text: "a\nb".into()
            })
            .is_err()
        );
        let slow = Swipe {
            from_x: 0,
            from_y: 0,
            to_x: 1,
            to_y: 1,
            duration_ms: Some(10_001),
        };
        assert!(validate_input(&slow).is_err());

        let typed = android_input_args(&Text {
            text: "it's a b;rm".into(),
        })
        .unwrap();
        assert_eq!(typed, ["input", "text", r"'it'\''s%sa%sb;rm'"]);
        assert!(
            android_input_args(&Text {
                text: "50%s".into()
            })
            .is_err()
        );
        assert_eq!(
            android_input_args(&Swipe {
                from_x: 1,
                from_y: 2,
                to_x: 3,
                to_y: 4,
                duration_ms: None
            })
            .unwrap(),
            ["input", "swipe", "1", "2", "3", "4", "300"]
        );
        assert_eq!(
            android_input_args(&Key {
                key: DeviceKey::Back
            })
            .unwrap(),
            ["input", "keyevent", "KEYCODE_BACK"]
        );

        assert_eq!(
            idb_input_args(&Tap { x: 5, y: 6 }, "U").unwrap(),
            ["ui", "tap", "5", "6", "--udid", "U"]
        );
        assert_eq!(
            idb_input_args(&Text { text: "a b".into() }, "U").unwrap(),
            ["ui", "text", "a b", "--udid", "U"]
        );
        assert!(
            idb_input_args(
                &Key {
                    key: DeviceKey::Back
                },
                "U"
            )
            .is_err()
        );
        assert_eq!(
            idb_input_args(
                &Key {
                    key: DeviceKey::Enter
                },
                "U"
            )
            .unwrap(),
            ["ui", "key", "40", "--udid", "U"]
        );
    }

    const SIMCTL: &str = r#"{
      "devices" : {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4" : [
          {"udid" : "87915d21-df21-41a4-bd5e-d76cad1e899b", "isAvailable" : false,
           "availabilityError" : "runtime profile not found using \"System\" match policy",
           "state" : "Shutdown", "name" : "iPhone 17 Pro"},
          {"udid" : "CF64CA6C-49D9-45CD-9B87-D1241832E69B", "isAvailable" : true,
           "state" : "Booted", "name" : "iPhone 17 Pro Max"},
          {"udid" : "BEB7852A-5E56-4A5E-9147-496AB6EB9396", "isAvailable" : true,
           "state" : "Shutdown", "name" : "iPad Air"},
          {"udid" : "not-a-udid", "isAvailable" : true, "state" : "Shutdown", "name" : "Bad"}
        ],
        "com.apple.CoreSimulator.SimRuntime.watchOS-11-0" : [
          {"udid" : "11111111-2222-3333-4444-555555555555", "isAvailable" : true,
           "state" : "Shutdown", "name" : "Watch"}
        ]
      }
    }"#;

    const ADB: &str = "List of devices attached\n\
        * daemon started successfully\n\
        emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\
        R58M12345AB            unauthorized usb:1-1 transport_id:2\n\
        192.168.1.20:5555      offline transport_id:3\n\
        0123456789             no permissions (user in plugdev group); see [http://developer.android.com/tools/device.html] usb:1-2\n\
        HT7A1B234567           device usb:1-3 product:walleye model:Pixel_2 device:walleye transport_id:4\n\n";

    #[test]
    fn device_ids_parse_only_listed_shapes() {
        let udid = "87915D21-DF21-41A4-BD5E-D76CAD1E899B";
        assert_eq!(
            Target::parse(&format!("ios-sim:{}", udid.to_lowercase())).unwrap(),
            Target::IosSimulator(udid.into())
        );
        assert_eq!(
            Target::parse("android-avd:Pixel_9_Pro").unwrap().id(),
            "android-avd:Pixel_9_Pro"
        );
        assert_eq!(
            Target::parse("android-serial:192.168.1.20:5555").unwrap(),
            Target::AndroidSerial("192.168.1.20:5555".into())
        );
        for bad in [
            "",
            "focused",
            "ios-sim:booted",
            "android-avd:-flag",
            "android-avd:a b",
            "android-serial:-s",
            "display:1",
            "usb:1-1",
        ] {
            assert!(Target::parse(bad).is_err(), "{bad} parsed");
        }
    }

    #[test]
    fn host_identity_is_stable_and_hides_the_machine_id() {
        let ioreg = "+-o J316sAP  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformSerialNumber\" = \"XYZ\"\n      \"IOPlatformUUID\" = \"9ef0aaaa-bbbb-cccc-dddd-2eb692517542\"\n    }\n";
        let uuid = parse_ioreg_platform_uuid(ioreg).unwrap();
        assert_eq!(uuid, "9EF0AAAA-BBBB-CCCC-DDDD-2EB692517542");
        let id = host_id(&uuid);
        assert_eq!(id, host_id(&format!("{uuid}\n")));
        assert!(id.starts_with("host-") && id.len() == 21);
        assert!(!id.contains("9EF0"));
        assert_ne!(id, host_id("other"));
        assert!(parse_ioreg_platform_uuid("\"IOPlatformUUID\" = \"nope\"").is_none());
        assert!(require_host(&id, &id).is_ok());
        assert!(require_host(&id, "host-0000000000000000").is_err());
    }

    #[test]
    fn simctl_devices_keep_ios_and_real_availability() {
        let simulators = parse_simctl_devices(SIMCTL).unwrap();
        assert_eq!(simulators.len(), 3);
        let missing = simulators
            .iter()
            .find(|s| s.name == "iPhone 17 Pro")
            .unwrap();
        assert!(!missing.available);
        assert_eq!(missing.udid, "87915D21-DF21-41A4-BD5E-D76CAD1E899B");
        assert_eq!(missing.runtime, "iOS 26.4");
        assert!(parse_simctl_devices("not json").is_err());
        assert!(parse_simctl_devices("{}").is_err());
        assert_eq!(simctl_state("Shutting Down"), DeviceState::ShuttingDown);
        assert_eq!(simctl_state("Creating"), DeviceState::Unknown);
    }

    #[test]
    fn ios_classification_explains_every_unavailable_capability() {
        let (family, devices) = classify_ios(IosProbe::Listed {
            xcrun: "/usr/bin/xcrun".into(),
            idb: None,
            simulators: parse_simctl_devices(SIMCTL).unwrap(),
        });
        assert!(family.available);
        let get = |name: &str, kind| {
            devices
                .iter()
                .find(|d| d.name == name)
                .unwrap()
                .capabilities
                .iter()
                .find(|c| c.capability == kind)
                .unwrap()
                .clone()
        };
        let boot = get("iPhone 17 Pro", DeviceCapability::Boot);
        assert!(!boot.available);
        assert_eq!(boot.reason.unwrap().code, DeviceReasonCode::RuntimeMissing);
        assert!(get("iPad Air", DeviceCapability::Boot).available);
        assert_eq!(
            get("iPad Air", DeviceCapability::Screenshot)
                .reason
                .unwrap()
                .code,
            DeviceReasonCode::DeviceNotBooted
        );
        assert!(get("iPhone 17 Pro Max", DeviceCapability::LaunchApp).available);
        assert_eq!(
            get("iPhone 17 Pro Max", DeviceCapability::Boot)
                .reason
                .unwrap()
                .code,
            DeviceReasonCode::DeviceBooted
        );

        let (family, devices) = classify_ios(IosProbe::ToolMissing("Install Xcode".into()));
        assert!(!family.available && devices.is_empty());
        assert_eq!(family.reasons[0].code, DeviceReasonCode::ToolMissing);
        let (family, _) = classify_ios(IosProbe::NotMacos);
        assert_eq!(
            family.reasons[0].code,
            DeviceReasonCode::PlatformUnsupported
        );
        let only_missing = parse_simctl_devices(SIMCTL)
            .unwrap()
            .into_iter()
            .filter(|s| !s.available)
            .collect();
        let (family, _) = classify_ios(IosProbe::Listed {
            xcrun: "x".into(),
            idb: None,
            simulators: only_missing,
        });
        assert!(!family.available);
        assert_eq!(family.reasons[0].code, DeviceReasonCode::RuntimeMissing);
        assert!(simctl_missing(
            "xcrun: error: unable to find utility \"simctl\", not a developer tool or in PATH"
        ));
        assert!(!simctl_missing("Invalid device: X"));
    }

    #[test]
    fn simctl_launch_reads_the_pid_for_the_named_bundle_only() {
        assert_eq!(
            parse_simctl_launch("com.example.app: 4242\n", "com.example.app"),
            Some(4242)
        );
        assert_eq!(
            parse_simctl_launch("com.other: 4242\n", "com.example.app"),
            None
        );
        assert_eq!(
            parse_simctl_launch("com.example.app: 0\n", "com.example.app"),
            None
        );
        assert_eq!(
            parse_plist_raw("com.example.app\n", "id").unwrap(),
            "com.example.app"
        );
        assert!(parse_plist_raw("\n", "id").is_err());
    }

    #[test]
    fn adb_devices_parse_every_state() {
        let devices = parse_adb_devices(ADB);
        let states: Vec<_> = devices
            .iter()
            .map(|d| (d.serial.as_str(), d.state.as_str()))
            .collect();
        assert_eq!(
            states,
            [
                ("emulator-5554", "device"),
                ("R58M12345AB", "unauthorized"),
                ("192.168.1.20:5555", "offline"),
                ("0123456789", "no permissions"),
                ("HT7A1B234567", "device"),
            ]
        );
        assert_eq!(devices[4].model.as_deref(), Some("Pixel_2"));
        assert!(devices[0].is_emulator() && !devices[4].is_emulator());
    }

    #[test]
    fn avd_and_emulator_outputs_parse() {
        assert_eq!(
            parse_avd_list(
                "INFO    | Storing crashdata\nPixel_9_Pro\n\nPixelWARNINGTest\nWARNING | x\n"
            ),
            ["PixelWARNINGTest", "Pixel_9_Pro"]
        );
        assert_eq!(
            parse_emu_avd_name("Pixel_9_Pro\r\nOK\r\n").as_deref(),
            Some("Pixel_9_Pro")
        );
        assert_eq!(parse_emu_avd_name("KO: unknown command\n"), None);
        assert_eq!(parse_emu_avd_name("Pixel_9_Pro\n"), None);
        assert!(boot_completed("1\n") && !boot_completed("\n") && !boot_completed("0"));
    }

    #[test]
    fn apk_and_package_outputs_parse() {
        let badging = "package: name='com.example.app' versionCode='42' versionName='1.2' platformBuildVersionName='14'\nsdkVersion:'24'\n";
        assert_eq!(
            parse_aapt_badging(badging).unwrap(),
            ("com.example.app".into(), "42".into())
        );
        assert!(parse_aapt_badging("ERROR: dump failed").is_err());
        assert!(parse_aapt_badging("package: name='x' versionCode='1'").is_err());
        let dumpsys = "Packages:\n  Package [com.example.app] (1a2b):\n    userId=10150\n    versionCode=42 minSdk=24 targetSdk=34\n  Package [com.other] (3c):\n    versionCode=7\n";
        assert_eq!(
            parse_dumpsys_version_code(dumpsys, "com.example.app").as_deref(),
            Some("42")
        );
        assert_eq!(
            parse_dumpsys_version_code(dumpsys, "com.other").as_deref(),
            Some("7")
        );
        assert_eq!(parse_dumpsys_version_code(dumpsys, "com.absent"), None);
        assert_eq!(
            parse_resolved_activity(
                "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.example.app/.MainActivity\n",
                "com.example.app"
            )
            .as_deref(),
            Some("com.example.app/.MainActivity")
        );
        assert_eq!(
            parse_resolved_activity("No activity found\n", "com.example.app"),
            None
        );
        assert_eq!(
            parse_resolved_activity("com.evil/.Main\n", "com.example.app"),
            None
        );
        assert_eq!(
            parse_resolved_activity("com.example.app/.Main;reboot\n", "com.example.app"),
            None
        );
        assert_eq!(parse_pid("12345 678\n"), Some(12345));
        assert_eq!(parse_pid(""), None);
        assert!(is_package("com.example.app") && !is_package("app") && !is_package("com.x;rm"));
        assert!(is_bundle_id("com.example-app") && !is_bundle_id("-x") && !is_bundle_id("a b"));
    }

    #[test]
    fn sdk_discovery_orders_roots_and_picks_newest_build_tools() {
        let roots = sdk_roots(Some("/sdk/a"), Some(""), Some(Path::new("/Users/me")), true);
        assert_eq!(
            roots,
            [
                PathBuf::from("/sdk/a"),
                PathBuf::from("/Users/me/Library/Android/sdk")
            ]
        );
        let names: Vec<String> = ["35.0.0", "36.1.0", "9.0.0", "37.0.0-rc1", "37.0.0", "junk"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(newest_build_tools(&names).as_deref(), Some("37.0.0"));
    }

    fn tools() -> AndroidTools {
        AndroidTools {
            adb: Some("/sdk/platform-tools/adb".into()),
            emulator: Some("/sdk/emulator/emulator".into()),
            aapt: Some("/sdk/build-tools/37.0.0/aapt2".into()),
        }
    }

    #[test]
    fn android_classification_keeps_stable_ids_and_explains_states() {
        let devices = parse_adb_devices(ADB);
        let running = devices
            .into_iter()
            .map(|device| RunningAndroid {
                avd: device.is_emulator().then(|| "Pixel_9_Pro".to_owned()),
                boot_completed: device.state == "device",
                device,
            })
            .collect();
        let (family, devices) = classify_android(AndroidProbe {
            tools: tools(),
            running: Ok(running),
            avds: Ok(vec!["Pixel_9_Pro".into(), "Small_Phone".into()]),
        });
        assert!(family.available && family.reasons.is_empty());
        let ids: Vec<_> = devices.iter().map(|d| d.device_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "android-avd:Pixel_9_Pro",
                "android-avd:Small_Phone",
                "android-serial:0123456789",
                "android-serial:192.168.1.20:5555",
                "android-serial:HT7A1B234567",
                "android-serial:R58M12345AB",
            ]
        );
        let running = &devices[0];
        assert_eq!(running.serial.as_deref(), Some("emulator-5554"));
        assert!(
            require(
                &devices,
                "android-avd:Pixel_9_Pro",
                DeviceCapability::Screenshot
            )
            .is_ok()
        );
        let error = require(&devices, "android-avd:Pixel_9_Pro", DeviceCapability::Boot)
            .unwrap_err()
            .to_string();
        assert!(error.contains("device_booted"), "{error}");
        assert!(require(&devices, "android-avd:Small_Phone", DeviceCapability::Boot).is_ok());
        let error = require(
            &devices,
            "android-serial:R58M12345AB",
            DeviceCapability::Screenshot,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("device_unauthorized"), "{error}");
        assert!(
            require(
                &devices,
                "android-serial:0123456789",
                DeviceCapability::LaunchApp
            )
            .unwrap_err()
            .to_string()
            .contains("device_no_permissions")
        );
        // A missing target is an error, never another device.
        assert!(
            require(&devices, "android-avd:Gone", DeviceCapability::Screenshot)
                .unwrap_err()
                .to_string()
                .contains("not attached")
        );
        assert!(
            require(
                &devices,
                "android-serial:HT7A1B234567",
                DeviceCapability::Boot
            )
            .unwrap_err()
            .to_string()
            .contains("not_supported")
        );
    }

    #[test]
    fn android_without_tools_is_explicitly_unavailable() {
        let (family, devices) = classify_android(AndroidProbe {
            tools: AndroidTools::default(),
            running: Ok(vec![]),
            avds: Ok(vec![]),
        });
        assert!(!family.available && devices.is_empty());
        assert_eq!(family.reasons.len(), 3);
        assert!(
            family
                .reasons
                .iter()
                .all(|r| r.code == DeviceReasonCode::ToolMissing)
        );
        let mut partial = tools();
        partial.aapt = None;
        let (_, devices) = classify_android(AndroidProbe {
            tools: partial,
            running: Ok(vec![RunningAndroid {
                device: AdbDevice {
                    serial: "emulator-5556".into(),
                    state: "device".into(),
                    model: None,
                },
                avd: None,
                boot_completed: false,
            }]),
            avds: Err("emulator failed".into()),
        });
        let device = &devices[0];
        assert_eq!(device.device_id, "android-serial:emulator-5556");
        assert_eq!(device.state, DeviceState::Booting);
        assert!(require(&devices, &device.device_id, DeviceCapability::Screenshot).is_err());
    }

    fn display(uuid: &str, width: u64, height: u64) -> Display {
        Display {
            uuid: uuid.into(),
            width,
            height,
            main: true,
            builtin: true,
        }
    }

    const UUID_A: &str = "11111111-2222-3333-4444-555555555555";
    const UUID_B: &str = "66666666-2222-3333-4444-555555555555";

    #[test]
    fn computer_needs_permission_and_one_provable_display() {
        use DevicePermissionState::*;
        let granted = Permissions {
            screen_recording: Granted,
            accessibility: Granted,
        };
        let (family, devices) =
            classify_computer(true, granted, Ok(vec![display(UUID_A, 1512, 982)]));
        assert!(family.available && family.reasons.is_empty());
        let id = format!("display:{UUID_A}");
        assert!(require(&devices, &id, DeviceCapability::Screenshot).is_ok());

        let denied = Permissions {
            screen_recording: Denied,
            accessibility: Denied,
        };
        let (family, devices) =
            classify_computer(true, denied, Ok(vec![display(UUID_A, 1512, 982)]));
        assert!(!family.available);
        assert_eq!(family.reasons.len(), 2);
        assert!(
            require(&devices, &id, DeviceCapability::Screenshot)
                .unwrap_err()
                .to_string()
                .contains("permission_denied")
        );

        let (_, devices) = classify_computer(
            true,
            granted,
            Ok(vec![
                display(UUID_A, 1512, 982),
                display(UUID_B, 1920, 1080),
            ]),
        );
        assert!(
            require(&devices, &id, DeviceCapability::Screenshot)
                .unwrap_err()
                .to_string()
                .contains("target_unverified")
        );

        let unsupported = Permissions {
            screen_recording: Unsupported,
            accessibility: Unsupported,
        };
        let (family, devices) = classify_computer(false, unsupported, Ok(vec![]));
        assert!(!family.available && devices.is_empty());
        assert_eq!(
            family.reasons[0].code,
            DeviceReasonCode::PlatformUnsupported
        );
    }

    #[test]
    fn png_capture_must_match_the_display() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&3024u32.to_be_bytes());
        png.extend_from_slice(&1964u32.to_be_bytes());
        let dims = png_dimensions(&png).unwrap();
        assert_eq!(dims, (3024, 1964));
        assert!(png_matches_display(dims, &display(UUID_A, 1512, 982)));
        assert!(!png_matches_display(dims, &display(UUID_A, 1920, 1080)));
        assert!(!png_matches_display(
            (3024, 982),
            &display(UUID_A, 1512, 982)
        ));
        assert!(png_dimensions(b"GIF89a").is_none());
    }

    #[test]
    fn replay_decisions_never_rerun_an_effect() {
        assert_eq!(
            decide_boot_replay(Some(DeviceState::Booted)),
            BootReplay::Booted
        );
        assert_eq!(
            decide_boot_replay(Some(DeviceState::Booting)),
            BootReplay::StillBooting
        );
        assert_eq!(
            decide_boot_replay(Some(DeviceState::Shutdown)),
            BootReplay::NotBooted
        );
        assert_eq!(decide_boot_replay(None), BootReplay::NotBooted);
        assert!(install_converged(Some("42"), "42"));
        assert!(!install_converged(Some("41"), "42"));
        assert!(!install_converged(None, "42"));
        assert_eq!(boot_timeout(None).unwrap(), DEFAULT_BOOT_TIMEOUT_MS);
        assert!(boot_timeout(Some(1)).is_err());
        assert!(boot_timeout(Some(MAX_BOOT_TIMEOUT_MS + 1)).is_err());
    }
}
