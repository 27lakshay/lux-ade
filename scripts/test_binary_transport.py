#!/usr/bin/env python3
"""Exercise ordered recovery against a temporary daemon and its real shell PTY."""
from paths import PROJECT_ROOT, TARGET_DIR
import json
import base64
import os
from pathlib import Path
from runtime_test_support import track_endpoint,cleanup_runtimes
import socket
import subprocess
import tempfile
import time

ROOT = PROJECT_ROOT
DAEMON = Path(os.environ.get('ADE_TEST_DAEMON', TARGET_DIR / 'debug/ade-daemon'))


def connect(endpoint):
    stream = socket.socket(socket.AF_UNIX)
    stream.settimeout(8)
    stream.connect(endpoint)
    return stream


def send(stream, value):
    stream.sendall((json.dumps(value) + '\n').encode())


def read(reader):
    line = reader.readline()
    assert line, 'daemon disconnected'
    return json.loads(line)


def run():
    with tempfile.TemporaryDirectory(prefix='ade-binary-') as directory:
        endpoint = str(Path(directory) / 'daemon.sock')
        env = dict(os.environ, ADE_SOCKET=endpoint, SHELL='/bin/sh', ENV='/dev/null')
        process = subprocess.Popen([str(DAEMON)], env=env, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.monotonic() + 8
            while not Path(endpoint).exists():
                assert process.poll() is None, process.stderr.read().decode()
                assert time.monotonic() < deadline, 'daemon startup timed out'
                time.sleep(.02)
            track_endpoint(endpoint)
            with connect(endpoint) as stream, stream.makefile('rb') as reader:
                send(stream, {'op': 'subscribe', 'snapshot_format': 'binary'})
                initial = read(reader)
                assert initial['type'] == 'snapshot', initial
                assert initial['terminal_snapshot_format'] == 'ghostty-snapshot-v1-herdr-9c96f7d'
                assert bytes(initial['terminal_snapshot_bytes']).startswith(b'GHOSTSNP')
                offset = initial['metrics']['terminal_bytes']
                send(stream, {'op': 'resize', 'cols': 80, 'rows': 24, 'claim': True})
                send(stream, {'op': 'input', 'data': "printf '\\033[?1049hBINARY_TRANSPORT_MARKER\\r\\n'\n"})
                output = bytearray()
                resized = False
                while True:
                    event = read(reader)
                    if event['type'] == 'terminal':
                        chunk = bytes(event['bytes'])
                        assert event['offset'] == offset, (event['offset'], offset)
                        offset += len(chunk)
                        output.extend(chunk)
                    elif event['type'] == 'terminal_resize':
                        assert event['offset'] == offset
                        assert (event['cols'], event['rows']) == (80, 24)
                        resized = True
                    elif event['type'] == 'metrics' and b'\x1b[?1049hBINARY_TRANSPORT_MARKER' in output:
                        assert event['metrics']['terminal_bytes'] == offset
                        assert resized, 'authoritative resize was not delivered'
                        break
            # Reconnect starts with another complete snapshot, not raw history.
            with connect(endpoint) as stream, stream.makefile('rb') as reader:
                send(stream, {'op': 'subscribe', 'snapshot_format': 'binary'})
                restored = read(reader)
                assert restored['type'] == 'snapshot'
                assert restored['metrics']['terminal_bytes'] >= offset
                assert 'terminal_bytes' not in restored
                assert len(restored['terminal_snapshot_bytes']) > 10
            with connect(endpoint) as stream, stream.makefile('rb') as reader:
                send(stream, {'op': 'subscribe', 'snapshot_format': 'binary', 'snapshot_encoding': 'base64'})
                compact = read(reader)
                assert 'terminal_snapshot_bytes' not in compact
                payload = base64.b64decode(compact['terminal_snapshot_base64'], validate=True)
                assert payload.startswith(b'GHOSTSNP') and len(payload) > 10
                assert compact['metrics']['terminal_bytes'] >= offset
            with connect(endpoint) as stream, stream.makefile('rb') as reader:
                send(stream, {'op': 'subscribe', 'terminal': False})
                gui = read(reader)
                assert not any(key.startswith('terminal_') for key in gui)
            print('BINARY_TRANSPORT_PASS: snapshot precedes contiguous output; legacy/compact reconnect and GUI isolation verified')
        finally:
            # Only the process group created by this test is terminated.
            import signal
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
            cleanup_runtimes()


if __name__ == '__main__':
    run()
