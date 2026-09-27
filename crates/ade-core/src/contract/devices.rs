//! Computer, iOS simulator and Android device contracts (F098, F099, F100;
//! decision D12).
//!
//! The daemon owns these adapters on its own physical host. Every targeted
//! operation names the host and a stable device identity from `device.list`;
//! the daemon never substitutes the focused, booted or only device, and it
//! refuses a host that is not its own. Missing permission, hardware or tools
//! produce an explicit unavailable capability with a reason, never a silent
//! fallback.
//!
//! Device identities:
//! - `display:<uuid>`: a display attached to the host, by its CoreGraphics UUID.
//! - `ios-sim:<udid>`: an iOS simulator.
//! - `android-avd:<name>`: an Android virtual device, booted or not.
//! - `android-serial:<serial>`: an adb device that is not an identified AVD.
use super::{FrameSpec, OperationSpec, Tier};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<DeviceListRequest, DeviceInventory>("device.list", Tier::Query),
        // Captures one exact device. It changes nothing on the device and
        // keeps no file; the image travels in the reply.
        OperationSpec::new::<DeviceScreenshotRequest, DeviceScreenshot>(
            "device.screenshot",
            Tier::Query,
        ),
        OperationSpec::new::<DeviceBootRequest, DeviceBooted>("device.boot", Tier::EffectCommand),
        OperationSpec::new::<DeviceAppInstallRequest, DeviceAppInstalled>(
            "device.app.install",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<DeviceAppLaunchRequest, DeviceAppLaunched>(
            "device.app.launch",
            Tier::EffectCommand,
        ),
        // One input event to one exact device. Whether an interrupted input
        // was delivered cannot be observed, so its replay is unknown.
        OperationSpec::new::<DeviceInputRequest, DeviceInputSent>(
            "device.input",
            Tier::EffectCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// A group of devices that share one adapter and its tools.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DeviceFamily {
    /// The host's own displays (screen access).
    Computer,
    /// iOS simulators through `xcrun simctl`.
    IosSimulator,
    /// Android emulators and devices through the Android SDK's `adb` and `emulator`.
    Android,
}

/// What kind of target a device is.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Display,
    Simulator,
    Emulator,
    Physical,
}

/// The device's observed state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceState {
    /// A display the host reports as active.
    Connected,
    Booted,
    Booting,
    ShuttingDown,
    Shutdown,
    /// adb sees the device but cannot talk to it.
    Offline,
    /// The device has not accepted this host's adb key.
    Unauthorized,
    /// The host user lacks USB permission for the device.
    NoPermissions,
    Unknown,
}

/// An operation a device can take.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceCapability {
    Screenshot,
    Boot,
    InstallApp,
    LaunchApp,
    /// Send touch, text and key input (`device.input`).
    Input,
}

/// Why a family or capability is unavailable.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceReasonCode {
    /// This host's operating system has no adapter for the family.
    PlatformUnsupported,
    /// A required tool is not installed or not selected.
    ToolMissing,
    /// A required tool ran and failed.
    ToolFailed,
    /// The operating system has not granted a required permission.
    PermissionDenied,
    /// The simulator's runtime or device type is not installed.
    RuntimeMissing,
    /// The device must be booted first.
    DeviceNotBooted,
    DeviceBooting,
    /// The device is already booted.
    DeviceBooted,
    DeviceOffline,
    DeviceUnauthorized,
    DeviceNoPermissions,
    /// ADE cannot prove it would act on this exact target.
    TargetUnverified,
    /// The family's adapter does not implement this capability.
    NotSupported,
}

/// A reason with the plain-language detail to show a user.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct DeviceReason {
    pub code: DeviceReasonCode,
    pub detail: String,
}

/// Whether one capability is available on one device now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct DeviceCapabilityStatus {
    pub capability: DeviceCapability,
    pub available: bool,
    /// Why it is unavailable; null when available.
    pub reason: Option<DeviceReason>,
}

/// One device on the host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct DeviceSummary {
    /// The stable identity every targeted operation names.
    pub device_id: String,
    pub family: DeviceFamily,
    pub kind: DeviceKind,
    pub name: String,
    pub state: DeviceState,
    /// The simulator runtime, such as `iOS 26.4`, or the AVD's name.
    pub runtime: Option<String>,
    /// The current adb serial of a running Android device. It can change
    /// between boots and is never a target.
    pub serial: Option<String>,
    pub capabilities: Vec<DeviceCapabilityStatus>,
}

/// An operating-system permission a family needs.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevicePermission {
    ScreenRecording,
    Accessibility,
}

/// What the operating system reports for a permission.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevicePermissionState {
    Granted,
    Denied,
    /// The host's operating system has no such permission check.
    Unsupported,
}

/// One permission as the operating system reports it to the daemon.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct DevicePermissionStatus {
    pub permission: DevicePermission,
    pub state: DevicePermissionState,
    /// Which process the answer is for. macOS attributes the daemon's
    /// permission to the application that launched it.
    pub subject: String,
}

/// One family's availability on the host.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct DeviceFamilyStatus {
    pub family: DeviceFamily,
    pub available: bool,
    /// Why the family, or part of it, is unavailable.
    pub reasons: Vec<DeviceReason>,
    /// The tools the adapter found, such as `/usr/bin/xcrun`.
    pub tools: Vec<String>,
    pub permissions: Vec<DevicePermissionStatus>,
}

/// The physical host whose devices these are.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct DeviceHost {
    /// Stable across restarts and renames: `host-` and 16 hex digits.
    pub host_id: String,
    pub host_name: String,
    /// `macos`, `linux` or another Rust target OS name.
    pub platform: String,
}

/// `device.list`: discover the host's devices and why any are unavailable.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceListRequest {
    /// Probe only this family; every family when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<DeviceFamily>,
}

wire_tag!(DeviceInventoryTag, "device_inventory");
wire_tag!(DeviceScreenshotTag, "device_screenshot");
wire_tag!(DeviceBootedTag, "device_booted");
wire_tag!(DeviceAppInstalledTag, "device_app_installed");
wire_tag!(DeviceAppLaunchedTag, "device_app_launched");
wire_tag!(DeviceInputSentTag, "device_input_sent");
wire_tag!(PngMime, "image/png");

/// The `device.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceInventory {
    #[serde(rename = "type")]
    pub tag: DeviceInventoryTag,
    pub host: DeviceHost,
    pub families: Vec<DeviceFamilyStatus>,
    pub devices: Vec<DeviceSummary>,
    pub observed_at_ms: i64,
}

/// `device.screenshot`: capture one exact device as a PNG.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceScreenshotRequest {
    pub host_id: String,
    pub device_id: String,
}

/// The `device.screenshot` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceScreenshot {
    #[serde(rename = "type")]
    pub tag: DeviceScreenshotTag,
    pub host_id: String,
    pub device_id: String,
    pub mime: PngMime,
    pub width: u64,
    pub height: u64,
    pub bytes: u64,
    /// Lowercase hex SHA-256 of the PNG bytes.
    pub sha256: String,
    pub captured_at_ms: i64,
    /// Standard base64 of the PNG, at most 16 MiB before encoding.
    pub bytes_base64: String,
}

/// `device.boot`: boot one simulator or AVD and wait until it is usable.
/// Booting a booted device records that it already was.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceBootRequest {
    pub operation_id: String,
    pub host_id: String,
    pub device_id: String,
    /// How long to wait for the boot to finish, 5000 to 300000 milliseconds;
    /// 120000 when absent. A boot still running at the deadline stays open:
    /// repeat the same operation ID to reconcile it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub timeout_ms: Option<u64>,
}

/// The `device.boot` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceBooted {
    #[serde(rename = "type")]
    pub tag: DeviceBootedTag,
    pub operation_id: String,
    pub host_id: String,
    pub device_id: String,
    /// True when the device was booted before this operation ran.
    pub already_booted: bool,
    /// The adb serial of a booted Android device.
    pub serial: Option<String>,
}

/// `device.app.install`: install an app bundle on one booted device. The
/// path is on the device's host: a `.app` directory for a simulator or an
/// `.apk` file for Android. The daemon reads the app's identity from the
/// bundle and confirms the device reports it installed at that version.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceAppInstallRequest {
    pub operation_id: String,
    pub host_id: String,
    pub device_id: String,
    pub app_path: String,
}

/// The `device.app.install` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceAppInstalled {
    #[serde(rename = "type")]
    pub tag: DeviceAppInstalledTag,
    pub operation_id: String,
    pub host_id: String,
    pub device_id: String,
    /// The bundle identifier or Android package name.
    pub app_id: String,
    /// `CFBundleVersion` or the Android version code.
    pub version: String,
}

/// `device.app.launch`: launch an installed app on one booted device.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceAppLaunchRequest {
    pub operation_id: String,
    pub host_id: String,
    pub device_id: String,
    /// The bundle identifier or Android package name.
    pub app_id: String,
}

/// The `device.app.launch` reply. It is sent only once the device reports a
/// process for the app.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceAppLaunched {
    #[serde(rename = "type")]
    pub tag: DeviceAppLaunchedTag,
    pub operation_id: String,
    pub host_id: String,
    pub device_id: String,
    pub app_id: String,
    /// The app's process ID on the device.
    pub pid: u64,
}

/// A key `device.input` can press. Not every family has every key: an iOS
/// simulator has no Back key.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKey {
    Home,
    Back,
    Enter,
    Delete,
    Tab,
    Escape,
}

/// One input event. Coordinates are in the device's input space: pixels on
/// Android (the screenshot's pixels), points on an iOS simulator.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeviceInputAction {
    Tap {
        x: u32,
        y: u32,
    },
    Swipe {
        from_x: u32,
        from_y: u32,
        to_x: u32,
        to_y: u32,
        /// 1 to 10000 milliseconds; 300 when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "u32")]
        duration_ms: Option<u32>,
    },
    /// Printable ASCII typed into the device's focused field, at most 1000
    /// characters.
    Text {
        text: String,
    },
    Key {
        key: DeviceKey,
    },
}

/// `device.input`: send one input event to one exact booted device. The
/// daemon never sends it to the focused, booted or only device instead, and
/// records who asked.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceInputRequest {
    pub operation_id: String,
    pub host_id: String,
    pub device_id: String,
    /// Who asks: the user, or an Agent naming its own Conversation.
    pub caller: super::orchestration::Caller,
    pub action: DeviceInputAction,
}

/// The `device.input` reply, sent once the device's tool accepted the event.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct DeviceInputSent {
    #[serde(rename = "type")]
    pub tag: DeviceInputSentTag,
    pub operation_id: String,
    pub host_id: String,
    pub device_id: String,
    pub action: DeviceInputAction,
    /// `user`, or `agent:<conversation ID>`.
    pub attribution: String,
    /// The adb serial the event went to on Android; null for a simulator.
    pub serial: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::bundle;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    fn names(op: &str) -> (String, String, Value) {
        let bundle = bundle();
        let spec = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone();
        (
            spec["request"].as_str().unwrap().to_owned(),
            spec["response"].as_str().unwrap().to_owned(),
            spec["tier"].clone(),
        )
    }

    fn valid(name: &str, value: &Value) -> bool {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle()["$defs"],
            "$ref": format!("#/$defs/{name}"),
        });
        jsonschema::validator_for(&schema).unwrap().is_valid(value)
    }

    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (name, _, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        let mut again = serde_json::to_value(decoded).unwrap();
        again["op"] = json!(op);
        assert_eq!(again, wire);
    }

    fn response<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name, _) = names(op);
        assert!(valid(&name, &wire), "{name} rejected {wire}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    #[test]
    fn effects_are_declared_as_effect_commands() {
        for op in [
            "device.boot",
            "device.app.install",
            "device.app.launch",
            "device.input",
        ] {
            assert_eq!(names(op).2, json!("effect_command"), "{op}");
        }
        for op in ["device.list", "device.screenshot"] {
            assert_eq!(names(op).2, json!("query"), "{op}");
        }
    }

    #[test]
    fn requests_round_trip_and_always_name_a_target() {
        request::<DeviceListRequest>("device.list", json!({"op": "device.list"}));
        request::<DeviceListRequest>(
            "device.list",
            json!({"op": "device.list", "family": "ios_simulator"}),
        );
        request::<DeviceScreenshotRequest>(
            "device.screenshot",
            json!({"op": "device.screenshot", "host_id": "host-1", "device_id": "ios-sim:A"}),
        );
        request::<DeviceBootRequest>(
            "device.boot",
            json!({"op": "device.boot", "operation_id": "o", "host_id": "host-1",
                "device_id": "android-avd:Pixel", "timeout_ms": 60000}),
        );
        request::<DeviceAppInstallRequest>(
            "device.app.install",
            json!({"op": "device.app.install", "operation_id": "o", "host_id": "h",
                "device_id": "ios-sim:A", "app_path": "/b/App.app"}),
        );
        request::<DeviceAppLaunchRequest>(
            "device.app.launch",
            json!({"op": "device.app.launch", "operation_id": "o", "host_id": "h",
                "device_id": "ios-sim:A", "app_id": "com.example"}),
        );
        request::<DeviceInputRequest>(
            "device.input",
            json!({"op": "device.input", "operation_id": "o", "host_id": "h",
                "device_id": "android-avd:Pixel",
                "caller": {"kind": "agent", "conversation_id": "c"},
                "action": {"kind": "swipe", "from_x": 1, "from_y": 2, "to_x": 3, "to_y": 4}}),
        );
        request::<DeviceInputRequest>(
            "device.input",
            json!({"op": "device.input", "operation_id": "o", "host_id": "h",
                "device_id": "ios-sim:A", "caller": {"kind": "user"},
                "action": {"kind": "key", "key": "home"}}),
        );
        // No operation falls back to a focused or default device or host.
        for (op, wire) in [
            (
                "device.screenshot",
                json!({"op": "device.screenshot", "host_id": "h"}),
            ),
            (
                "device.screenshot",
                json!({"op": "device.screenshot", "device_id": "d"}),
            ),
            (
                "device.boot",
                json!({"op": "device.boot", "host_id": "h", "device_id": "d"}),
            ),
            (
                "device.app.launch",
                json!({"op": "device.app.launch", "operation_id": "o", "host_id": "h",
                    "device_id": "d"}),
            ),
            // Input always names its device and its caller.
            (
                "device.input",
                json!({"op": "device.input", "operation_id": "o", "host_id": "h",
                    "caller": {"kind": "user"}, "action": {"kind": "tap", "x": 1, "y": 1}}),
            ),
            (
                "device.input",
                json!({"op": "device.input", "operation_id": "o", "host_id": "h",
                    "device_id": "d", "action": {"kind": "tap", "x": 1, "y": 1}}),
            ),
        ] {
            let (name, _, _) = names(op);
            assert!(!valid(&name, &wire), "{op} accepted {wire}");
        }
    }

    #[test]
    fn replies_round_trip_in_the_daemon_shape() {
        response::<DeviceInventory>(
            "device.list",
            json!({"type": "device_inventory",
                "host": {"host_id": "host-0123456789abcdef", "host_name": "mac", "platform": "macos"},
                "families": [{"family": "computer", "available": false,
                    "reasons": [{"code": "permission_denied", "detail": "Grant Screen Recording"}],
                    "tools": [],
                    "permissions": [{"permission": "screen_recording", "state": "denied",
                        "subject": "daemon"}]}],
                "devices": [{"device_id": "android-avd:Pixel", "family": "android",
                    "kind": "emulator", "name": "Pixel", "state": "booted",
                    "runtime": null, "serial": "emulator-5554",
                    "capabilities": [{"capability": "boot", "available": false,
                        "reason": {"code": "device_booted", "detail": "Already booted"}},
                        {"capability": "screenshot", "available": true, "reason": null}]}],
                "observed_at_ms": 5}),
        );
        response::<DeviceScreenshot>(
            "device.screenshot",
            json!({"type": "device_screenshot", "host_id": "h", "device_id": "d",
                "mime": "image/png", "width": 2, "height": 3, "bytes": 8, "sha256": "ab",
                "captured_at_ms": 1, "bytes_base64": "iVBORw0KGgo="}),
        );
        response::<DeviceBooted>(
            "device.boot",
            json!({"type": "device_booted", "operation_id": "o", "host_id": "h",
                "device_id": "d", "already_booted": false, "serial": null}),
        );
        response::<DeviceAppInstalled>(
            "device.app.install",
            json!({"type": "device_app_installed", "operation_id": "o", "host_id": "h",
                "device_id": "d", "app_id": "com.example", "version": "7"}),
        );
        response::<DeviceAppLaunched>(
            "device.app.launch",
            json!({"type": "device_app_launched", "operation_id": "o", "host_id": "h",
                "device_id": "d", "app_id": "com.example", "pid": 42}),
        );
        response::<DeviceInputSent>(
            "device.input",
            json!({"type": "device_input_sent", "operation_id": "o", "host_id": "h",
                "device_id": "d", "action": {"kind": "text", "text": "hi"},
                "attribution": "agent:c", "serial": "emulator-5554"}),
        );
    }
}
