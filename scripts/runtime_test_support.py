"""Track and explicitly stop only supervisors created by an isolated test."""
import time
from pathlib import Path
from runtime import rpc

_owned = {}

def track_runtime(hello):
    if hello.get("runtime_socket"):
        _owned[hello["runtime_instance"]] = Path(hello["runtime_socket"])

def track_endpoint(endpoint):
    track_runtime(rpc(endpoint,{"op":"hello"}))

def cleanup_runtimes():
    for instance, endpoint in list(_owned.items()):
        for attempt in range(50):
            try:
                rpc(endpoint, {"op": "runtime.stop", "instance_id": instance, "stop_active": True})
                break
            except (FileNotFoundError, ConnectionRefusedError):
                break
            except RuntimeError as error:
                if "Runtime identity changed" in str(error):
                    break  # This tracked instance was already replaced; do not stop its successor.
                if attempt == 49:
                    raise
                time.sleep(0.02)
        _owned.pop(instance, None)
