"""Real process lifecycle checks for the Python fixture cleanup helper."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import runtime_test_support as support

SUPERVISOR = '''
import json,socket,sys,time
from pathlib import Path
endpoint=Path(sys.argv[1])
server=socket.socket(socket.AF_UNIX)
server.bind(str(endpoint));server.listen()
Path(sys.argv[2]).write_text('ready')
peer,_=server.accept()
with peer.makefile('rb') as reader:request=json.loads(reader.readline())
assert request['op']=='runtime.stop' and request['instance_id']=='fixture-instance'
peer.sendall(b'{"type":"ack"}\\n');peer.close()
time.sleep(.3)
server.close()
'''


class RuntimeCleanupTests(unittest.TestCase):
    def tearDown(self):
        support._owned.clear()

    def test_stop_acknowledgement_does_not_finish_cleanup_before_process_exit(self):
        with tempfile.TemporaryDirectory(prefix='ade-runtime-cleanup-', dir='/tmp') as directory:
            root = Path(directory)
            child = subprocess.Popen([sys.executable, '-c', SUPERVISOR, str(root/'runtime.sock'), str(root/'ready')])
            try:
                import time
                deadline = time.monotonic() + 5
                while not (root/'ready').exists() and time.monotonic() < deadline:
                    self.assertIsNone(child.poll())
                    time.sleep(.01)
                self.assertTrue((root/'ready').exists())
                support.track_runtime({'runtime_socket': str(root/'runtime.sock'),
                                       'runtime_instance': 'fixture-instance', 'runtime_pid': child.pid})
                support.cleanup_runtimes()
                self.assertEqual(child.poll(), 0, 'Stop acknowledgement returned while the owned supervisor was alive')
            finally:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=5)

    def test_missing_endpoint_with_live_owned_process_is_not_cleanup_success(self):
        with tempfile.TemporaryDirectory(prefix='ade-runtime-cleanup-', dir='/tmp') as directory:
            child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
            try:
                support.track_runtime({'runtime_socket': str(Path(directory)/'missing.sock'),
                                       'runtime_instance': 'fixture-instance', 'runtime_pid': child.pid})
                with self.assertRaisesRegex(RuntimeError, 'cleanup is unconfirmed'):
                    support.cleanup_runtimes()
                self.assertIsNone(child.poll())
                self.assertIn('fixture-instance', support._owned)
            finally:
                child.terminate()
                child.wait(timeout=5)

    def test_unconfirmed_cleanup_retains_the_scratch_directory(self):
        root = None
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            with self.assertRaisesRegex(RuntimeError, 'cleanup is unconfirmed'):
                with support.scratch_directory(prefix='ade-runtime-retained-', dir='/tmp') as directory:
                    root = Path(directory)
                    (root/'diagnostic.txt').write_text('fixture diagnostic')
                    support.track_runtime({'runtime_socket': str(root/'missing.sock'),
                                           'runtime_instance': 'fixture-instance', 'runtime_pid': child.pid})
                    support.cleanup_runtimes()
            self.assertTrue(root.is_dir())
            self.assertEqual((root/'diagnostic.txt').read_text(), 'fixture diagnostic')
        finally:
            child.terminate()
            child.wait(timeout=5)
            support._owned.clear()
            if root is not None:
                shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()
