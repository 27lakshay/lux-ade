#!/usr/bin/env python3
"""Controlled real-PTY workload, invoked by benchmark.py, not a fake renderer."""
from pathlib import Path
import os
import select
import sys
import termios
import time
import tty

mode = sys.argv[1]
if mode == 'history':
    for i in range(60000):
        os.write(1, f'HISTORY {i:06d} '.encode() + b'x' * 96 + b'\r\n')
    os.write(1, b'\r\nADE_HISTORY_DONE\r\n')
    if len(sys.argv) > 2: Path(sys.argv[2]).write_text('done')
else:
    saved = termios.tcgetattr(0)
    try:
        tty.setraw(0)
        os.write(1, b'\r\nADE_BENCH_READY\r\n')
        deadline = time.monotonic() + float(sys.argv[2])
        pending = bytearray()
        chunk = (b'\x1b[32mADE controlled output\x1b[0m ' + b'x' * 70 + b'\r\n') * 25
        next_output = time.monotonic()
        while time.monotonic() < deadline:
            if mode == 'stream' and time.monotonic() >= next_output:
                os.write(1, chunk)
                next_output += .01  # About 260 KiB/s, plus echo markers.
            if select.select([0], [], [], .002)[0]:
                pending.extend(os.read(0, 4096))
                while b'\n' in pending:
                    line, _, pending = pending.partition(b'\n')
                    os.write(1, line + b'\r\n')
    finally:
        termios.tcsetattr(0, termios.TCSANOW, saved)
    os.write(1, b'\r\nADE_BENCH_DONE\r\n')
