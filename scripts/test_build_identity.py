"""Build detection covers provider-only changes without hashing dependency trees."""
import tempfile
import unittest
from pathlib import Path
from runtime import build_identity


class BuildIdentityTests(unittest.TestCase):
    def test_provider_source_dependencies_additions_and_removals_change_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'daemon'
            binary.write_bytes(b'unchanged executable')
            providers = root / 'providers'
            providers.mkdir()
            identity = lambda: build_identity(binary, providers)
            previous = identity()
            for name in ('bridge.mjs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'):
                source = providers / name
                source.write_text('first')
                self.assertNotEqual(previous, identity())
                previous = identity()
                source.write_text('second')
                self.assertNotEqual(previous, identity())
                previous = identity()
                source.unlink()
                self.assertNotEqual(previous, identity())
                previous = identity()
            binary.write_bytes(b'new executable')
            self.assertNotEqual(previous, identity())

    def test_tests_and_installed_dependency_trees_do_not_change_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / 'daemon'
            binary.write_bytes(b'executable')
            providers = root / 'providers'
            providers.mkdir()
            before = build_identity(binary, providers)
            for name in ('node_modules/dependency/index.mjs', 'bridge.test.mjs', 'mock-cli.mjs', 'protocol-fixture.mjs', 'fake-sdk.mjs'):
                source = providers / name
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text('not production bridge source')
            self.assertEqual(before, build_identity(binary, providers))


if __name__ == '__main__':
    unittest.main()
