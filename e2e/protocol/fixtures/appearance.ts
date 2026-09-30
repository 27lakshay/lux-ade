// The program reads the actual PTY replies. The view must never answer these
// queries: the native core owns the program's effective appearance.
export const queryProgram = String.raw`
import os, select, termios, time, tty
saved = termios.tcgetattr(0)
tty.setraw(0)
try:
    os.write(1, b'\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07\x1b[?996n')
    reply = b''
    deadline = time.monotonic() + 5
    while b'\x1b[?997;' not in reply or not reply.endswith(b'n'):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError('terminal did not answer appearance queries')
        reply += os.read(0, 4096)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
print('\r\nAPPEARANCE:' + reply.hex(), flush=True)
`
