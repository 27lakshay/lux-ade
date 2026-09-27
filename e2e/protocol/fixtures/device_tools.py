#!/usr/bin/env python3
"""PATH-shim stand-ins for `xcrun simctl`, `idb`, `adb`, `emulator` and `aapt2`.

One fixture host directory holds `state.json` (the simulated host's
simulators, Android devices, AVDs and installed apps), `calls.jsonl` (every
invocation) and the shims. Each shim runs `device_tools.py TOOL HOSTDIR ...`
and prints output recorded from the real tools. Nothing here touches a real
simulator, emulator, device or the user's SDK.

A hold pauses one action so a spec can fault the daemon mid-effect: the shim
writes `held-<key>` and waits for `release-<key>`, or exits as soon as its
parent (the daemon) dies. `phase: "after"` applies the effect before waiting.
"""
import fcntl
import json
import os
from pathlib import Path
import plistlib
import struct
import sys
import time
import zlib

tool = sys.argv[1]
host = Path(sys.argv[2])
args = sys.argv[3:]
parent = os.getppid()


def locked(update=None):
    """Read the state, optionally changing it, under an exclusive lock."""
    with open(host / "state.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads((host / "state.json").read_text())
        if update is not None:
            result = update(state)
            temporary = host / "state.json.tmp"
            temporary.write_text(json.dumps(state, indent=2))
            temporary.replace(host / "state.json")
            return state, result
        return state, None


def record(extra=None):
    with open(host / "calls.jsonl", "a") as file:
        file.write(json.dumps({"tool": tool, "args": args, "pid": os.getpid(), **(extra or {})}) + "\n")


def fail(message, code=1, stdout=""):
    if stdout:
        sys.stdout.write(stdout)
    sys.stderr.write(message + "\n")
    sys.exit(code)


def hold(key, phase):
    """Pause at `key` when the state asks for it in this phase."""
    def take(state):
        wanted = state.get("holds", {}).get(key)
        if wanted and wanted.get("phase", "before") == phase:
            del state["holds"][key]
            return True
        return False
    _, held = locked(take)
    if not held:
        return
    (host / f"held-{key}").write_text(str(os.getpid()))
    while not (host / f"release-{key}").exists():
        if os.getppid() != parent:
            record({"abandoned": key})
            sys.exit(1)
        time.sleep(0.02)


def png(width, height):
    rows = b"".join(b"\x00" + b"\x7f\x7f\x7f" * width for _ in range(height))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def next_pid(state):
    state["next_pid"] = state.get("next_pid", 4100) + 1
    return state["next_pid"]


# ---- xcrun simctl ---------------------------------------------------------------

def simulator(state, udid):
    return next((sim for sim in state["simulators"] if sim["udid"].upper() == udid.upper()), None)


def simctl():
    state, _ = locked()
    mode = state.get("simctl", "ok")
    if mode == "missing":
        fail('xcrun: error: unable to find utility "simctl", not a developer tool or in PATH', 72)
    if mode == "failed":
        fail("An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\n"
             "Unable to locate device set.", 148)
    if args[:1] != ["simctl"]:
        fail(f"xcrun: error: unhandled {args}", 64)
    command, rest = args[1], args[2:]

    if command == "list" and rest == ["devices", "-j"]:
        grouped = {}
        for sim in state["simulators"]:
            entry = {"udid": sim["udid"], "isAvailable": sim.get("isAvailable", True), "state": sim["state"],
                     "name": sim["name"], "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
                     "dataPath": f"/Users/fixture/Library/Developer/CoreSimulator/Devices/{sim['udid']}/data",
                     "logPath": f"/Users/fixture/Library/Logs/CoreSimulator/{sim['udid']}"}
            if sim.get("availabilityError"):
                entry["availabilityError"] = sim["availabilityError"]
            grouped.setdefault(f"com.apple.CoreSimulator.SimRuntime.{sim['runtime']}", []).append(entry)
        print(json.dumps({"devices": grouped}, indent=2))
        return

    udid = rest[0] if rest else ""
    if simulator(state, udid) is None:
        fail(f"Invalid device: {udid}", 148)

    if command == "bootstatus":
        hold("bootstatus", "before")
        def boot(state):
            sim = simulator(state, udid)
            already = sim["state"] == "Booted"
            sim["state"] = "Booted"
            return already
        _, already = locked(boot)
        record()
        hold("bootstatus", "after")
        name = simulator(locked()[0], udid)["name"]
        if already:
            print(f"Monitoring boot status for {name} ({udid}).\nDevice already booted, nothing to do.")
        else:
            print(f"Monitoring boot status for {name} ({udid}).\nWaiting on Data Migration\nFinished Data Migration\n"
                  "Waiting on System App\nFinished System App\nDevice booted in 4.21 seconds")
        return

    sim = simulator(state, udid)
    if sim["state"] != "Booted" and command in ("install", "launch", "io"):
        fail("An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\n"
             "Unable to lookup in current state: Shutdown", 149)

    if command == "install":
        bundle = Path(rest[1])
        info = plistlib.loads((bundle / "Info.plist").read_bytes())
        hold("install", "before")
        def install(state):
            container = host / "containers" / udid.upper() / bundle.name
            container.mkdir(parents=True, exist_ok=True)
            if not state.get("install_breaks_container"):
                (container / "Info.plist").write_bytes((bundle / "Info.plist").read_bytes())
            installed = state.get("install_reports_version") or info["CFBundleVersion"]
            state.setdefault("sim_apps", {}).setdefault(udid.upper(), {})[info["CFBundleIdentifier"]] = {
                "container": str(container), "version": installed}
            if installed != info["CFBundleVersion"] and not state.get("install_breaks_container"):
                plist = dict(info, CFBundleVersion=installed)
                (container / "Info.plist").write_bytes(plistlib.dumps(plist))
        locked(install)
        record()
        hold("install", "after")
        return

    if command == "get_app_container":
        app = state.get("sim_apps", {}).get(udid.upper(), {}).get(rest[1])
        if not app:
            fail("An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\n"
                 "Failed to get the app container\nNo such file or directory", 2)
        print(app["container"])
        return

    if command == "launch":
        bundle = rest[1]
        if bundle not in state.get("sim_apps", {}).get(udid.upper(), {}):
            fail(f"An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=4):\n"
                 f"The request to open \"{bundle}\" failed.", 4)
        hold("launch", "before")
        _, pid = locked(next_pid)
        record({"launched_pid": pid})
        if state.get("launch_without_pid"):
            print(f"{bundle}: launching")
        else:
            print(f"{bundle}: {pid}")
        return

    if command == "io" and rest[1] == "screenshot":
        target = rest[-1]
        Path(target).write_bytes(png(1206, 2622 if not state.get("small_screens") else 8))
        record()
        sys.stderr.write(f"Detected file type 'PNG' from extension\nWrote screenshot to: {target}\n")
        return

    fail(f"simctl fixture does not handle {command}", 64)


# ---- adb ------------------------------------------------------------------------

def device(state, serial):
    return next((entry for entry in state["android"]["devices"] if entry["serial"] == serial), None)


def adb():
    state, _ = locked()
    if args[:2] == ["devices", "-l"]:
        lines = ["List of devices attached"]
        for entry in state["android"]["devices"]:
            detail = entry.get("detail", "")
            lines.append(f"{entry['serial']:<22} {entry['state']} {detail}".rstrip())
        print("\n".join(lines) + "\n")
        return
    if args[:1] != ["-s"]:
        fail(f"adb fixture does not handle {args}", 1)
    serial, rest = args[1], args[2:]
    entry = device(state, serial)
    if entry is None:
        fail(f"adb: device '{serial}' not found", 1)
    if entry["state"] != "device":
        fail(f"adb: device {entry['state']}" if entry["state"] != "unauthorized" else
             "adb: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set\n"
             "Try 'adb kill-server' if that seems wrong.\nOtherwise check for a confirmation dialog on your device.", 1)

    if rest == ["emu", "avd", "name"]:
        if not entry.get("avd"):
            fail("error: could not connect to TCP port 5554: Connection refused", 1)
        print(f"{entry['avd']}\r\nOK\r")
        return
    if rest == ["shell", "getprop", "sys.boot_completed"]:
        print("1" if entry.get("boot_completed") else "")
        return
    apps = state["android"].setdefault("apps", {}).setdefault(serial, {})
    if rest[:3] == ["shell", "dumpsys", "package"]:
        package = rest[3]
        app = apps.get(package)
        if app:
            print(f"Activity Resolver Table:\n  Non-Data Actions:\n      android.intent.action.MAIN:\n"
                  f"        1b6c2f0 {package}/.MainActivity filter 9a3e1d1\n\nPackages:\n"
                  f"  Package [{package}] (2c9f8e4):\n    userId=10190\n    pkg=Package{{8d1f0a5 {package}}}\n"
                  f"    versionCode={app['versionCode']} minSdk=24 targetSdk=35\n    versionName=1.0\n")
        return
    if rest[:2] == ["install", "-r"]:
        apk = json.loads(Path(rest[2]).read_text())
        hold("adb-install", "before")
        def install(state):
            state["android"]["apps"].setdefault(serial, {})[apk["package"]] = {
                "versionCode": apk["versionCode"], "activity": apk["activity"]}
        locked(install)
        record()
        print("Performing Streamed Install\nSuccess")
        return
    if rest[:5] == ["shell", "cmd", "package", "resolve-activity", "--brief"]:
        package = rest[-1]
        app = apps.get(package)
        if not app:
            print("No activity found")
            return
        print(f"priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n{package}/{app['activity']}")
        return
    if rest[:4] == ["shell", "am", "start", "-W"]:
        component = rest[-1]
        package = component.split("/")[0]
        hold("am-start", "before")
        def start(state):
            pid = next_pid(state)
            state["android"]["apps"][serial][package]["pid"] = pid
            return pid
        _, pid = locked(start)
        record({"launched_pid": pid})
        print(f"Starting: Intent {{ act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] cmp={component} }}\n"
              f"Status: ok\nLaunchState: COLD\nActivity: {component}\nTotalTime: 412\nWaitTime: 415\nComplete")
        return
    if rest[:2] == ["shell", "pidof"]:
        pid = apps.get(rest[2], {}).get("pid")
        if not pid:
            sys.exit(1)
        print(pid)
        return
    if rest[:2] == ["shell", "input"]:
        hold("adb-input", "before")
        if state.get("input_error"):
            # adb shell reports a device-side failure on stdout and exits 0.
            print(f"Error: {state['input_error']}")
            return
        record({"serial": serial, "input": rest[2:]})
        return
    if rest == ["exec-out", "screencap", "-p"]:
        record()
        sys.stdout.buffer.write(png(1080, 2400))
        return
    fail(f"adb fixture does not handle {rest}", 1)


# ---- idb ------------------------------------------------------------------------

def idb():
    state, _ = locked()
    if args[:1] != ["ui"] or "--udid" not in args:
        fail(f"idb fixture does not handle {args}", 2)
    udid = args[args.index("--udid") + 1]
    sim = simulator(state, udid)
    if sim is None:
        fail(f"idb: error: Target with udid {udid} is unknown to idb", 1)
    if sim["state"] != "Booted":
        fail(f"idb: error: Target {udid} is not booted (state={sim['state']})", 1)
    hold("idb-input", "before")
    record({"udid": udid.upper(), "input": args[1:args.index("--udid")]})


# ---- emulator -------------------------------------------------------------------

def emulator():
    if args == ["-list-avds"]:
        state, _ = locked()
        print("INFO    | Storing crashdata in: /tmp/android-fixture/emu-crash-35.3.11.db, detection is enabled for process: 4242")
        print("\n".join(state["android"]["avds"]))
        return
    if args[:1] == ["-avd"]:
        name = args[1]
        hold("emulator", "before")
        def start(state):
            used = {entry["serial"] for entry in state["android"]["devices"]}
            port = 5554
            while f"emulator-{port}" in used:
                port += 2
            state["android"]["devices"].append({"serial": f"emulator-{port}", "state": "device", "avd": name,
                                                "boot_completed": True,
                                                "detail": f"product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:{port}"})
        locked(start)
        record()
        return
    fail(f"emulator fixture does not handle {args}", 1)


# ---- aapt2 ----------------------------------------------------------------------

def aapt2():
    if args[:2] != ["dump", "badging"]:
        fail(f"aapt2 fixture does not handle {args}", 1)
    try:
        apk = json.loads(Path(args[2]).read_text())
    except (OSError, ValueError):
        fail(f"W/ziparchive: Unable to open '{args[2]}': Invalid file\nerror: failed opening zip: {args[2]}.", 1)
    print(f"package: name='{apk['package']}' versionCode='{apk['versionCode']}' versionName='1.0' "
          f"platformBuildVersionName='15' platformBuildVersionCode='35' compileSdkVersion='35' compileSdkVersionCodename='15'\n"
          f"sdkVersion:'24'\ntargetSdkVersion:'35'\n"
          f"launchable-activity: name='{apk['package']}{apk['activity']}'  label='Fixture' icon=''")


tools = {"xcrun": simctl, "idb": idb, "adb": adb, "emulator": emulator, "aapt2": aapt2}
tools[tool]()
