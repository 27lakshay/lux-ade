#!/usr/bin/env python3
"""Run inside the daemon PTY; record terminal replies without a UI dependency."""
import json
import os
from pathlib import Path
import select
import sys
import termios
import time
import tty

saved = termios.tcgetattr(0)
received = bytearray()
try:
    tty.setraw(0)
    if '--flood' in sys.argv:
        payload = b'\x1b[6n' * 500000
        while payload:
            payload = payload[os.write(1, payload):]
        Path(sys.argv[1] + '.drained').write_text('output drained')
        time.sleep(.5)
    size = os.get_terminal_size(0)
    # CUP clamps to the current viewport. Native panes may have fewer than ten
    # rows; the reply must reflect their actual PTY size, not the initial size.
    expected = f'\x1b[{min(10, size.lines)};{min(20, size.columns)}R'.encode() + b'\x1b[?62;22c\x1b[>1;10;0c'
    os.write(1, b'\x1b[10;20H\x1b[6n\x1b[c\x1b[>c')
    deadline = time.monotonic() + 0.7
    while time.monotonic() < deadline:
        if select.select([0], [], [], max(0, deadline - time.monotonic()))[0]:
            received.extend(os.read(0, 4096))
finally:
    termios.tcsetattr(0, termios.TCSANOW, saved)
Path(sys.argv[1]).write_text(json.dumps({'reply': list(received), 'expected': list(expected)}))
