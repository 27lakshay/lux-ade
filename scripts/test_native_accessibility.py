"""Exercise the AppKit bridge with a real window and fake AccessKit host."""
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    if sys.platform != "darwin":
        print("Native accessibility bridge requires macOS; skipped.")
        return
    native = Path(__file__).resolve().parents[1] / "crates/ade-platform/native"
    with tempfile.TemporaryDirectory(prefix="ade-native-ax-") as directory:
        binary = Path(directory) / "native-accessibility"
        subprocess.run([
            "xcrun", "clang", "-fobjc-arc", "-framework", "AppKit",
            str(native / "accessibility.m"), str(native / "tests/accessibility.m"),
            "-o", str(binary),
        ], check=True, timeout=60)
        subprocess.run([str(binary)], check=True, timeout=15)
    print("Native accessibility: virtual children preserved; native children deduplicated, hidden and removed correctly.")


if __name__ == "__main__":
    main()
