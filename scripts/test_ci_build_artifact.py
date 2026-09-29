import json
import os
from pathlib import Path
import tempfile
import unittest

import ci_build_artifact as artifact

class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'source'
        self.destination = self.base / 'destination'
        self.source.mkdir()
        self.destination.mkdir()
        self.bundle = self.base / 'bundle'
        self.identity = {'revision': 'abc', 'architecture': 'arm64', 'sourceSha256': '123'}
        for name in artifact.REQUIRED['native']:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'build-output')
            path.chmod(0o755)

    def pack(self):
        artifact.pack(self.source, 'native', self.bundle, self.identity)

    def test_round_trip_preserves_executable_and_leaves_profile_out(self):
        (self.source / 'profile.sqlite').write_bytes(b'private state')
        self.pack()
        artifact.restore(self.destination, 'native', self.bundle, self.identity)
        for name in artifact.REQUIRED['native']:
            self.assertEqual(artifact.file_record(self.source/name), artifact.file_record(self.destination/name))
        self.assertFalse((self.destination/'profile.sqlite').exists())

    def test_symlinked_output_directory_is_not_archived(self):
        target = self.source / 'target'
        target.rename(self.source / 'elsewhere')
        target.symlink_to(self.source / 'elsewhere', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            self.pack()
        self.assertFalse(self.bundle.exists())

    def test_restore_does_not_modify_an_existing_hardlink_peer(self):
        self.pack()
        peer = self.base / 'unrelated-binary'
        peer.write_bytes(b'old executable')
        destination = self.destination / artifact.REQUIRED['native'][0]
        destination.parent.mkdir(parents=True)
        os.link(peer, destination)
        artifact.restore(self.destination, 'native', self.bundle, self.identity)
        self.assertEqual(peer.read_bytes(), b'old executable')
        self.assertEqual(destination.read_bytes(), b'build-output')

    def test_missing_outputs_fail_pack(self):
        (self.source / artifact.REQUIRED['native'][0]).unlink()
        with self.assertRaisesRegex(ValueError, 'Missing build output'):
            self.pack()

    def test_source_or_platform_mismatch_changes_nothing(self):
        self.pack()
        for field in ['revision', 'architecture', 'sourceSha256']:
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                artifact.restore(self.destination, 'native', self.bundle, {**self.identity, field:'other'})
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_corrupt_payload_changes_nothing(self):
        self.pack()
        manifest_path = self.bundle/'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['files'][artifact.REQUIRED['native'][-1]]['sha256'] = 'wrong'
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'integrity mismatch'):
            artifact.restore(self.destination, 'native', self.bundle, self.identity)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_undeclared_output_is_rejected(self):
        self.pack()
        manifest_path = self.bundle/'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['files']['../../outside'] = {'size':1}
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'undeclared'):
            artifact.restore(self.destination, 'native', self.bundle, self.identity)
        self.assertEqual(list(self.destination.iterdir()), [])

if __name__ == '__main__':
    unittest.main()
