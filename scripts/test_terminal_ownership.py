#!/usr/bin/env python3
"""Real-PTY ownership regression. Uses only a temporary daemon and shell."""
from paths import PROJECT_ROOT, TARGET_DIR
import json
import os
from pathlib import Path
from runtime_test_support import track_endpoint,cleanup_runtimes
import shlex
import signal
import socket
import subprocess
import tempfile
import time

ROOT = PROJECT_ROOT
CLIENT = Path(os.environ.get('ADE_TEST_CLIENT', TARGET_DIR / 'debug/ade-client'))
DAEMON = Path(os.environ.get('ADE_TEST_DAEMON', TARGET_DIR / 'debug/ade-daemon'))
FIXTURE = Path(__file__).with_name('terminal_query_fixture.py')


def connect(endpoint):
    stream = socket.socket(socket.AF_UNIX)
    stream.settimeout(5)
    stream.connect(endpoint)
    return stream


def send(stream, value):
    stream.sendall((json.dumps(value) + '\n').encode())


def query(endpoint, directory, label):
    result = Path(directory) / f'{label}.json'
    with connect(endpoint) as stream:
        command = f'python3 {shlex.quote(str(FIXTURE))} {shlex.quote(str(result))}\n'
        send(stream, {'op': 'input', 'data': command})
        send(stream, {'op': 'ping'})
        stream.makefile('rb').readline()
    deadline = time.monotonic() + 6
    while not result.exists():
        assert time.monotonic() < deadline, 'query fixture timed out'
        time.sleep(.02)
    data = json.loads(result.read_text())
    assert data['reply'] == data['expected'], f"{label}: expected exactly one reply, got {bytes(data['reply'])!r}"


def metrics(endpoint):
    with connect(endpoint) as stream, stream.makefile('rb') as reader:
        send(stream, {'op': 'ping'})
        return json.loads(reader.readline())['metrics']


def observed_clients(endpoint):
    # A one-shot metrics probe may sample before or after its own stream is
    # counted. Repeated probes expose a persistent viewer without depending on
    # that timing.
    return max(metrics(endpoint)['clients'] for _ in range(10))


def barrier(stream):
    send(stream, {'op': 'ping'})
    return json.loads(stream.makefile('rb').readline())['metrics']


def ownership(endpoint):
    first, second = connect(endpoint), connect(endpoint)
    try:
        send(first, {'op': 'resize', 'cols': 80, 'rows': 24, 'claim': True})
        owner_first = barrier(first)['resize_owner']
        send(second, {'op': 'resize', 'cols': 90, 'rows': 25, 'claim': False})
        assert barrier(second)['resize_owner'] == owner_first, 'opening a viewer stole ownership'
        send(second, {'op': 'resize', 'cols': 90, 'rows': 25, 'claim': True})
        owner_second = barrier(second)['resize_owner']
        assert owner_first != owner_second
        # Typing claims ownership even without a separate resize request.
        send(first, {'op': 'input', 'data': ''})
        assert barrier(first)['resize_owner'] == owner_first
        first.close()
        deadline = time.monotonic() + 3
        while metrics(endpoint)['resize_owner'] != owner_second:
            assert time.monotonic() < deadline, 'owner did not transfer on disconnect'
            time.sleep(.02)
        with connect(endpoint) as stream, stream.makefile('rb') as reader:
            send(stream, {'op': 'snapshot'})
            recovery = json.loads(reader.readline())['terminal_recovery']
            assert (recovery['cols'], recovery['rows']) == (90, 25)
    finally:
        first.close()
        second.close()
    print('OWNERSHIP_PASS: typing claims; disconnect transfers owner and restores remaining viewer dimensions')


def passive_handoff(endpoint):
    for _ in range(12):
        viewers = [connect(endpoint) for _ in range(3)]
        try:
            for index, stream in enumerate(viewers):
                send(stream, {'op':'resize', 'cols':80 + index, 'rows':24, 'claim':False})
                barrier(stream)
            # Later passive registrations must win a tie when the first owner closes.
            viewers[0].close()
            deadline = time.monotonic() + 3
            while True:
                with connect(endpoint) as stream, stream.makefile('rb') as reader:
                    send(stream, {'op':'snapshot'})
                    cols = json.loads(reader.readline())['terminal_recovery']['cols']
                if cols == 82: break
                assert time.monotonic() < deadline, f'passive handoff chose {cols}, expected 82'
                time.sleep(.02)
        finally:
            for stream in viewers: stream.close()
        deadline = time.monotonic() + 3
        while metrics(endpoint)['resize_owner'] is not None:
            assert time.monotonic() < deadline
            time.sleep(.02)
    print('OWNERSHIP_PASS: deterministic passive handoff across 12 registrations')


def query_flood(endpoint, directory):
    result = Path(directory) / 'flood.json'
    with connect(endpoint) as stream:
        send(stream, {'op':'input', 'data':f'python3 {shlex.quote(str(FIXTURE))} {shlex.quote(str(result))} --flood\n'})
        barrier(stream)
    deadline = time.monotonic() + 15
    while not result.exists():
        # This previously timed out while the State mutex was held by the reader.
        metrics(endpoint)
        assert time.monotonic() < deadline, 'query flood stalled output'
        time.sleep(.05)
    assert Path(str(result) + '.drained').exists()
    assert metrics(endpoint)['reply_dropped_bytes'] > 0, 'fixture did not saturate the reply queue'
    print('OWNERSHIP_PASS: query flood drains output and preserves daemon responsiveness; dropped replies are counted')


def run():
    with tempfile.TemporaryDirectory(prefix='ade-owner-') as directory:
        endpoint = str(Path(directory) / 'daemon.sock')
        process = subprocess.Popen([str(DAEMON)], env=dict(os.environ, ADE_SOCKET=endpoint, SHELL='/bin/sh'),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while not Path(endpoint).exists():
                assert process.poll() is None
                assert time.monotonic() < deadline
                time.sleep(.02)
            track_endpoint(endpoint)
            query(endpoint, directory, 'no-viewers')
            print('OWNERSHIP_PASS: exactly one daemon reply with no viewers')
            ownership(endpoint)
            passive_handoff(endpoint)
            deadline = time.monotonic() + 5
            while observed_clients(endpoint) > 1:
                assert time.monotonic() < deadline, 'viewer cleanup stalled'
                time.sleep(.02)
            baseline = metrics(endpoint)
            shell_pid = baseline['shell_pid']
            assert shell_pid > 0
            for viewers in (1, 4, 10):
                client = subprocess.Popen([str(CLIENT), '--windows', str(viewers)],
                    env=dict(os.environ, ADE_SOCKET=endpoint), stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, start_new_session=True)
                try:
                    # New windows now start with empty panes. Merely opening the
                    # app must not attach terminal viewers or restart its shell.
                    time.sleep(.6)
                    assert client.poll() is None, 'native client exited'
                    state = metrics(endpoint)
                    assert observed_clients(endpoint) <= 1, f'empty windows attached terminal viewers: {state}'
                    assert state['shell_pid'] == shell_pid, 'empty windows replaced the shell'
                    query(endpoint, directory, f'{viewers}-empty-windows')
                    print(f'OWNERSHIP_PASS: {viewers} empty native windows leave the terminal detached')
                finally:
                    os.killpg(client.pid, signal.SIGTERM)
                    client.wait(timeout=5)
                deadline = time.monotonic() + 5
                while observed_clients(endpoint) > 1:
                    assert time.monotonic() < deadline, 'viewer subscriptions leaked'
                    time.sleep(.02)
                assert metrics(endpoint)['shell_pid'] == shell_pid, 'closing windows stopped the shell'
            query_flood(endpoint, directory)
        finally:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
            cleanup_runtimes()


if __name__ == '__main__':
    run()
