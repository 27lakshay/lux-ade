"""Track and explicitly stop only supervisors created by an isolated test."""
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from runtime import rpc

_owned = {}


def track_runtime(hello):
    if hello.get('runtime_socket'):
        pid = hello.get('runtime_pid')
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            raise RuntimeError('Runtime cleanup requires a captured process identity')
        _owned[hello['runtime_instance']] = (Path(hello['runtime_socket']), pid)


def track_endpoint(endpoint):
    track_runtime(rpc(endpoint, {'op': 'hello'}))


def _exited(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    # A child zombie has exited but has not yet been reaped by its parent.
    state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='],
                           capture_output=True, text=True, timeout=2)
    return state.returncode == 0 and state.stdout.strip().startswith('Z')


def cleanup_runtimes():
    for instance, (endpoint, pid) in list(_owned.items()):
        unavailable = False
        for attempt in range(50):
            try:
                rpc(endpoint, {'op': 'runtime.stop', 'instance_id': instance, 'stop_active': True})
                break
            except (FileNotFoundError, ConnectionRefusedError):
                unavailable = True
                break
            except RuntimeError as error:
                if 'Runtime identity changed' in str(error):
                    unavailable = True
                    break  # Never stop a successor at this endpoint.
                if attempt == 49:
                    raise
                time.sleep(.02)
        # An acknowledgement precedes runtime shutdown. Do not unlink its wake-up socket.
        deadline = time.monotonic() + (0 if unavailable else 5)
        while not _exited(pid):
            if time.monotonic() >= deadline:
                raise RuntimeError(f'Runtime cleanup is unconfirmed; retained endpoint: {endpoint}, pid: {pid}')
            time.sleep(.02)
        _owned.pop(instance, None)


@contextmanager
def scratch_directory(prefix, dir=None):
    """Retain a scratch root while a captured supervisor's exit remains unconfirmed."""
    root = Path(tempfile.mkdtemp(prefix=prefix, dir=dir))
    try:
        yield str(root)
    finally:
        if any(endpoint.is_relative_to(root) for endpoint, _ in _owned.values()):
            print(f'Runtime cleanup is unconfirmed; retained scratch directory: {root}', file=sys.stderr)
        else:
            shutil.rmtree(root)
