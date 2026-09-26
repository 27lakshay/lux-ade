#!/usr/bin/env python3
"""Hold a browser profile's advisory lock for the Electron parent lifetime."""

import fcntl
import os
import sys


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(sys.argv[1], flags, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.write(1, b"busy\n")
            return 3
        os.write(1, b"ready\n")
        # stdin is a pipe owned only by Electron. A crash closes it and the OS
        # releases the lock even when Electron cannot run a shutdown handler.
        while os.read(0, 4096):
            pass
        return 0
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    raise SystemExit(main())
