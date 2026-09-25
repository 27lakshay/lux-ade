#!/usr/bin/env python3
"""Run in the daemon PTY while detached; reconnect and inspect the fixed marker."""
import sys
try:
    sys.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[32mRECOVERY: fixed marker survives discarded history\x1b[0m')
    for i in range(20000):
        sys.stdout.write(f'\x1b[3;1HUpdating one row: {i:05d}')
    sys.stdout.write('\x1b[5;1HRECOVERY_DONE - press Enter to return to the shell\x1b[?25l\x1b[?2004h\x1b[7;9H')
    sys.stdout.flush()
    input()
finally:
    sys.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l')
    sys.stdout.flush()
