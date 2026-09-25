"""Portable setup must reject corrupt downloads and escaping archive members."""
import hashlib
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
import bootstrap

class BootstrapTests(unittest.TestCase):
    def test_rejects_cached_checksum_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            expected = hashlib.sha256(b'expected').hexdigest()
            (cache / expected).write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'Corrupt cached'):
                bootstrap.fetch({'sha256': expected, 'url': 'https://invalid.test'}, cache)

    def test_rejects_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'source.tar'
            with tarfile.open(archive, 'w') as tar:
                entry = tarfile.TarInfo('../escape')
                entry.size = 1
                tar.addfile(entry, io.BytesIO(b'x'))
            with self.assertRaisesRegex(RuntimeError, 'Unsafe archive'):
                bootstrap.extract(archive, root / 'out')

    def test_internal_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'source.tar'
            with tarfile.open(archive, 'w') as tar:
                entry = tarfile.TarInfo('source/LICENSE')
                entry.size = 1
                tar.addfile(entry, io.BytesIO(b'x'))
                link = tarfile.TarInfo('source/package/LICENSE')
                link.type = tarfile.SYMTYPE
                link.linkname = '../LICENSE'
                tar.addfile(link)
            bootstrap.extract(archive, root / 'out')
            self.assertEqual((root / 'out/source/package/LICENSE').read_text(), 'x')

    def test_rejects_external_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'source.tar'
            with tarfile.open(archive, 'w') as tar:
                link = tarfile.TarInfo('source/link')
                link.type = tarfile.SYMTYPE
                link.linkname = '../../escape'
                tar.addfile(link)
            with self.assertRaisesRegex(RuntimeError, 'Unsafe archive link'):
                bootstrap.extract(archive, root / 'out')


class PackagingTests(unittest.TestCase):
    def test_staging_removes_stale_files_and_dereferences_links(self):
        import package
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'; source.mkdir()
            (source / 'current').write_text('current')
            (source / 'link').symlink_to('current')
            destination = root / 'destination'; destination.mkdir()
            (destination / 'stale').write_text('old')
            package.replace_tree(source, destination, symlinks=False)
            self.assertFalse((destination / 'stale').exists())
            self.assertFalse((destination / 'link').is_symlink())
            self.assertEqual((destination / 'link').read_text(), 'current')

class RuntimePathTests(unittest.TestCase):
    def test_bundle_resolves_sibling_daemon_and_provider_resources(self):
        import runpy
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve() / 'Relocated App.app/Contents'
            scripts = root / 'Resources/scripts'; scripts.mkdir(parents=True)
            shutil.copy2(Path(__file__).with_name('runtime.py'), scripts / 'runtime.py')
            module = runpy.run_path(str(scripts / 'runtime.py'))
            self.assertEqual(module['PROJECT'], root / 'Resources')
            self.assertEqual(module['DEFAULT_DAEMON'], root / 'MacOS/ade-daemon')

class ReleaseMetadataTests(unittest.TestCase):
    @unittest.skipUnless(__import__('sys').platform == 'darwin', 'requires macOS Mach-O tools')
    def test_symbols_match_and_only_packaged_copy_is_stripped(self):
        import shutil
        import subprocess
        import release_metadata
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'fixture.c'
            source.write_text('int main(void) { return 0; }\n')
            binary = root / 'fixture'
            packaged = root / 'packaged'
            subprocess.run(['xcrun', 'clang', '-g', '-c', str(source), '-o', str(root / 'fixture.o')], check=True)
            subprocess.run(['xcrun', 'clang', str(root / 'fixture.o'), '-o', str(binary)], check=True)
            original = binary.read_bytes()
            shutil.copy2(binary, packaged)
            metadata = release_metadata.preserve_symbols(binary, packaged, root / 'symbols')
            self.assertEqual(binary.read_bytes(), original)
            self.assertEqual(release_metadata.uuids(packaged), metadata['uuids'])
            self.assertTrue((root / 'symbols/fixture.dSYM/Contents/Resources/DWARF/fixture').is_file())
            self.assertNotEqual(packaged.read_bytes(), original)
            subprocess.run([str(packaged)], check=True)

    @unittest.skipUnless(__import__('sys').platform == 'darwin', 'requires macOS Mach-O tools')
    def test_refuses_to_strip_when_source_has_no_debug_symbols(self):
        import shutil
        import subprocess
        import release_metadata
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'fixture.c'
            source.write_text('int main(void) { return 0; }\n')
            binary = root / 'fixture'
            packaged = root / 'packaged'
            subprocess.run(['xcrun', 'clang', str(source), '-o', str(binary)], check=True)
            shutil.copy2(binary, packaged)
            original = packaged.read_bytes()
            with self.assertRaisesRegex(RuntimeError, 'Incomplete debug symbols'):
                release_metadata.preserve_symbols(binary, packaged, root / 'symbols')
            self.assertEqual(packaged.read_bytes(), original)

    def test_notices_preserve_text_and_digest(self):
        import json
        import release_metadata
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'native').mkdir()
            (root / 'native/dependencies.json').write_text(json.dumps({'sources': {
                'fixture': {'url': 'https://example.invalid/source', 'sha256': 'abc'}}}))
            source = root / '.ade/vendor/fixture'; source.mkdir(parents=True)
            (source / 'LICENSE').write_text('Fixture license\n')
            output = root / 'notices'
            entries = release_metadata.notices(root, output)
            self.assertEqual(entries[0]['sha256'], hashlib.sha256(b'Fixture license\n').hexdigest())
            self.assertEqual((output / 'licenses/fixture/LICENSE').read_bytes(), (source / 'LICENSE').read_bytes())

class ProviderPackagingTests(unittest.TestCase):
    def test_internal_pnpm_links_survive_relocation_without_duplicate_packages(self):
        import package
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'providers'; source.mkdir()
            store = source / 'example/node_modules/.pnpm/pkg/node_modules/pkg'
            store.mkdir(parents=True)
            (store / 'index.js').write_text('export default 1;')
            (source / 'example/node_modules/pkg').symlink_to('.pnpm/pkg/node_modules/pkg')
            (source / 'example/bridge.test.mjs').write_text('fixture')
            destination = root / 'packaged'
            package.copy_providers(source, destination)
            link = destination / 'example/node_modules/pkg'
            self.assertTrue(link.is_symlink())
            self.assertTrue(link.resolve().is_relative_to(destination.resolve()))
            self.assertFalse((destination / 'example/bridge.test.mjs').exists())
            self.assertEqual((link / 'index.js').read_text(), 'export default 1;')

    def test_escaping_dependency_link_is_rejected(self):
        import package
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'providers'; source.mkdir()
            (root / 'external').write_text('outside')
            (source / 'link').symlink_to('../external')
            with self.assertRaisesRegex(RuntimeError, 'escapes'):
                package.copy_providers(source, root / 'packaged')

class SourceFingerprintTests(unittest.TestCase):
    def fixture(self, root):
        entry = {'sha256': '', 'url': 'https://invalid.test', 'subdirectory': 'fixture'}
        cache = root / 'downloads'; cache.mkdir()
        archive = root / 'source.tar'
        with tarfile.open(archive, 'w') as tar:
            item = tarfile.TarInfo('fixture/source.txt'); item.size = 7
            tar.addfile(item, io.BytesIO(b'pinned\n'))
        entry['sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.rename(cache / entry['sha256'])
        return entry, cache, root / 'missing.patch'

    def test_changed_patch_rejects_existing_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry, cache, patch = self.fixture(root)
            bootstrap.install_source('fixture', entry, root, cache, patch)
            patch.write_text('changed patch')
            with self.assertRaisesRegex(RuntimeError, 'Pinned source or patch changed'):
                bootstrap.install_source('fixture', entry, root, cache, patch)
            self.assertEqual((root / 'vendor/fixture/source.txt').read_text(), 'pinned\n')

    def test_unstamped_modified_source_is_not_blessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry, cache, patch = self.fixture(root)
            destination = root / 'vendor/fixture'; destination.mkdir(parents=True)
            (destination / 'source.txt').write_text('local edits')
            with self.assertRaisesRegex(RuntimeError, 'Unstamped dependency differs'):
                bootstrap.install_source('fixture', entry, root, cache, patch)
            self.assertFalse((root / 'source-metadata/fixture.json').exists())
            self.assertEqual((destination / 'source.txt').read_text(), 'local edits')

    def test_equal_legacy_source_is_verified_then_stamped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry, cache, patch = self.fixture(root)
            destination = root / 'vendor/fixture'; destination.mkdir(parents=True)
            (destination / 'source.txt').write_text('pinned\n')
            bootstrap.install_source('fixture', entry, root, cache, patch)
            self.assertTrue((root / 'source-metadata/fixture.json').is_file())

class PatchIsolationTests(unittest.TestCase):
    def test_patch_applies_inside_an_unrelated_parent_repository(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            source = root / 'temporary/source'; source.mkdir(parents=True)
            (source / 'hello.txt').write_text('before\n')
            patch = root / 'change.patch'
            patch.write_text('--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n')
            bootstrap.run('git', 'apply', '--check', patch, cwd=source)
            bootstrap.run('git', 'apply', patch, cwd=source)
            self.assertEqual((source / 'hello.txt').read_text(), 'after\n')
            self.assertFalse((root / 'hello.txt').exists())

class ProviderShimTests(unittest.TestCase):
    def test_generated_shim_does_not_keep_checkout_node_path(self):
        import package
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / 'providers'
            shim = source / 'example/node_modules/.bin/example'
            shim.parent.mkdir(parents=True)
            shim.write_text('#!/bin/sh\nbasedir=$(dirname "$0")\nexport NODE_PATH="' + str(source) + '/example/node_modules"\n')
            destination = root / 'packaged'
            package.copy_providers(source, destination)
            output = (destination / shim.relative_to(source)).read_text()
            self.assertNotIn(str(source), output)
            self.assertIn('${basedir}/', output)

class RustNoticeTests(unittest.TestCase):
    def test_resolved_scope_missing_text_and_safe_notice_copy(self):
        import json
        import rust_notices
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'native').mkdir()
            (root / 'native/dependencies.json').write_text('{"sources": {}}')
            (root / 'Cargo.lock').write_text('# fixture')
            packages = []
            for name, expression, declared in [('ade', None, None), ('licensed', 'MIT OR Apache-2.0', 'terms.txt'), ('spdx-only', 'MIT', None)]:
                base = root / name
                base.mkdir()
                (base / 'Cargo.toml').write_text('# fixture')
                packages.append({'id': name, 'name': name, 'version': '1.0.0',
                                 'source': None if name == 'ade' else 'registry+https://example.test/index',
                                 'manifest_path': str(base / 'Cargo.toml'), 'license': expression,
                                 'license_file': declared, 'repository': None})
            (root / 'licensed/terms.txt').write_text('retained exact text')
            (root / 'licensed/NOTICE').write_text('attribution')
            (root / 'licensed/LICENSE-escape').symlink_to(root / 'Cargo.lock')
            nodes = [{'id': p['id'], 'features': ['default'], 'deps': []} for p in packages]
            nodes[0]['deps'] = [{'pkg': 'licensed', 'name': 'renamed',
                                 'dep_kinds': [{'kind': 'build', 'target': 'cfg(unix)'}, {'kind': 'dev', 'target': None}]}]
            metadata = {'packages': packages, 'workspace_members': ['ade'], 'resolve': {'nodes': nodes}}
            destination = root / 'out'
            first = rust_notices.inventory(root, destination, metadata, {'limits': 'Fixture scope'})
            second = rust_notices.inventory(root, destination, metadata, {'limits': 'Fixture scope'})
            self.assertEqual(first, second)
            entries = {p['name']: p for p in first['packages']}
            self.assertEqual(entries['licensed']['license_expression'], 'MIT OR Apache-2.0')
            self.assertEqual(len(entries['licensed']['notices']), 2)
            self.assertTrue(any('outside package' in issue for issue in entries['licensed']['issues']))
            self.assertTrue(any('No license or notice text' in issue for issue in entries['spdx-only']['issues']))
            self.assertEqual(entries['ade']['dependencies'][0]['kinds'][0]['kind'], 'build')
            self.assertEqual(entries['ade']['dependencies'][0]['kinds'][1]['kind'], 'dev')
            self.assertNotIn(str(root), json.dumps(first))
            for notice in entries['licensed']['notices']:
                self.assertTrue((destination / notice['path']).is_file())

class ProviderNoticeTests(unittest.TestCase):
    def test_pnpm_aliases_are_deduplicated_and_edges_resolve(self):
        import json
        import provider_notices
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'providers'
            provider = root / 'fixture'
            modules = provider / 'node_modules'
            package = modules / '.pnpm/pkg@1/node_modules/pkg'
            package.mkdir(parents=True)
            (provider / 'package.json').write_text(json.dumps({'name': 'ade-fixture', 'dependencies': {'pkg': '1'}}))
            (provider / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
            (package / 'package.json').write_text(json.dumps({'name': 'pkg', 'version': '1', 'license': 'MIT OR Apache-2.0', 'optionalDependencies': {'absent': '2'}}))
            (package / 'LICENSE').write_text('exact notice')
            (modules / 'pkg').symlink_to('.pnpm/pkg@1/node_modules/pkg')
            (modules / 'alias').symlink_to('.pnpm/pkg@1/node_modules/pkg')
            destination = Path(directory) / 'notices'
            result = provider_notices.collect(root, destination)
            self.assertEqual(len(result['packages']), 2)
            entry = next(p for p in result['packages'] if p['name'] == 'pkg')
            self.assertEqual(len(entry['aliases']), 2)
            self.assertEqual(len(entry['notices']), 1)
            self.assertEqual(entry['license_declaration'], 'MIT OR Apache-2.0')
            self.assertIsNone(entry['dependencies'][0]['resolved'])
            self.assertEqual(entry['review'], 'text-retained-unreviewed')
            own = next(p for p in result['packages'] if p['provider_root'])
            self.assertEqual(own['dependencies'][0]['resolved'], entry['id'])
            self.assertTrue(own['issues'])
            self.assertNotIn(str(root), json.dumps(result))
            self.assertEqual(provider_notices.collect(root, destination), result)
            self.assertEqual((destination / entry['notices'][0]['path']).read_text(), 'exact notice')
            (package / 'terms.txt').write_text('custom terms')
            (package / 'package.json').write_text(json.dumps({'name': 'pkg', 'version': '1', 'license': 'SEE LICENSE IN terms.txt'}))
            custom = provider_notices.collect(root, destination)
            self.assertEqual(len(next(p for p in custom['packages'] if p['name'] == 'pkg')['notices']), 2)

    def test_escape_and_broken_symlinks_fail_closed(self):
        import provider_notices
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'providers'
            modules = root / 'fixture/node_modules'
            modules.mkdir(parents=True)
            link = modules / 'escape'
            link.symlink_to(Path(directory))
            with self.assertRaisesRegex(RuntimeError, 'escapes or is broken'):
                provider_notices.collect(root, Path(directory) / 'out')
            link.unlink()
            link.symlink_to('missing')
            with self.assertRaisesRegex(RuntimeError, 'escapes or is broken'):
                provider_notices.collect(root, Path(directory) / 'out')

class NativeNoticeTests(unittest.TestCase):
    def test_cached_notices_fonts_and_recursive_manifest_evidence(self):
        import native_notices
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / 'cache'
            cache.mkdir()
            archive = cache / 'fixture-hash.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                for name, data in [('source/OFL.txt', b'exact font notice'), ('source/font.ttf', b'font bytes'),
                                   ('source/build.zig.zon', b'.{ .dependencies = .{ .child = .{ .url = "https://example.test/child", .hash = "child-hash" } } }')]:
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    output.addfile(member, io.BytesIO(data))
            record, children = native_notices.cached_package(cache, {'name': 'font', 'hash': 'fixture-hash', 'url': 'https://example.test/font'}, root / 'out')
            self.assertEqual(len(record['notices']), 1)
            self.assertEqual(len(record['font_files']), 1)
            self.assertEqual(children[0]['hash'], 'child-hash')
            self.assertEqual((root / 'out' / record['notices'][0]['path']).read_bytes(), b'exact font notice')
            missing, _ = native_notices.cached_package(cache, children[0], root / 'out')
            self.assertIn('unavailable', missing['issues'][0])

    def test_packaged_resource_hashes_headers_and_escape(self):
        import json
        import native_notices
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'native').mkdir()
            (root / 'native/dependencies.json').write_text('{"sources": {}}')
            resources = root / 'resources'
            script = resources / 'ghostty/shell-integration/test.sh'
            script.parent.mkdir(parents=True)
            script.write_text('# SPDX-License-Identifier: GPL-3.0-or-later\necho fixture\n')
            inventory = native_notices.collect(root, resources, root / 'out', root / 'cache')
            entry = inventory['resources'][0]
            self.assertEqual(entry['sha256'], hashlib.sha256(script.read_bytes()).hexdigest())
            self.assertIn('GPL-3.0-or-later', entry['header_evidence'][0])
            self.assertTrue(all('issue' in entry for entry in inventory['static_archives']))
            self.assertNotIn(str(root), json.dumps(inventory))
            (resources / 'ghostty/escape').symlink_to(root / 'native/dependencies.json')
            with self.assertRaisesRegex(RuntimeError, 'escapes packaged tree'):
                native_notices.collect(root, resources, root / 'out', root / 'cache')

    def test_cached_archive_escape_is_rejected_without_extraction(self):
        import native_notices
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with tarfile.open(root / 'bad.tar.gz', 'w:gz') as output:
                member = tarfile.TarInfo('../LICENSE')
                member.size = 1
                output.addfile(member, io.BytesIO(b'x'))
            with self.assertRaisesRegex(RuntimeError, 'Unsafe Zig cache archive'):
                native_notices.cached_package(root, {'name': 'bad', 'hash': 'bad'}, root / 'out')
            self.assertFalse((root / 'LICENSE').exists())

class UnsignedArchiveTests(unittest.TestCase):
    @unittest.skipUnless(__import__('sys').platform == 'darwin', 'requires ditto and Mach-O tools')
    def test_extracted_app_and_symbol_archives_preserve_links_and_pairing(self):
        import json
        import shutil
        import subprocess
        import release_metadata
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'lux-ade Fixture.app'
            binaries = app / 'Contents/MacOS'
            resources = app / 'Contents/Resources'
            binaries.mkdir(parents=True)
            resources.mkdir()
            source = root / 'fixture.c'
            source.write_text('int main(void) { return 0; }\n')
            subprocess.run(['xcrun', 'clang', '-g', '-c', str(source), '-o', str(root / 'fixture.o')], check=True)
            binary = root / 'fixture'
            subprocess.run(['xcrun', 'clang', str(root / 'fixture.o'), '-o', str(binary)], check=True)
            packaged = binaries / 'ade-client'
            shutil.copy2(binary, packaged)
            symbols = root / 'symbols-fixture'
            metadata = release_metadata.preserve_symbols(binary, packaged, symbols)
            manifest = {'build_id': 'fixture', 'binaries': {'ade-client': metadata}}
            (resources / 'build-manifest.json').write_text(json.dumps(manifest))
            (symbols / 'build-manifest.json').write_text(json.dumps(manifest))
            dependencies = resources / 'providers/fixture/node_modules'
            physical = dependencies / '.pnpm/pkg@1/node_modules/pkg'
            physical.mkdir(parents=True)
            (physical / 'index.js').write_text('export default 1')
            (dependencies / 'pkg').symlink_to('.pnpm/pkg@1/node_modules/pkg')
            third_party = resources / 'third-party'
            third_party.mkdir()
            inventories = ('third-party-inventory.json', 'rust-dependency-inventory.json', 'provider-dependency-inventory.json', 'native-resource-inventory.json')
            for name in inventories:
                (third_party / name).write_text('{"fixture":true}')
            for source_tree, name in [(app, 'app'), (symbols, 'symbols')]:
                archive = root / (name + '.zip')
                subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(source_tree), str(archive)], check=True)
                subprocess.run(['ditto', '-x', '-k', str(archive), str(root / 'extracted')], check=True)
            extracted = root / 'extracted/lux-ade Fixture.app/Contents'
            extracted_symbols = root / 'extracted/symbols-fixture'
            link = extracted / 'Resources/providers/fixture/node_modules/pkg'
            self.assertTrue(link.is_symlink())
            self.assertTrue(link.resolve().is_relative_to(extracted.resolve()))
            self.assertEqual((link / 'index.js').read_text(), 'export default 1')
            for name in inventories:
                self.assertEqual((extracted / 'Resources/third-party' / name).read_bytes(), (third_party / name).read_bytes())
            self.assertEqual(json.loads((extracted_symbols / 'build-manifest.json').read_text()), json.loads(json.dumps(manifest)))
            self.assertEqual(release_metadata.uuids(extracted / 'MacOS/ade-client'), release_metadata.uuids(extracted_symbols / 'fixture.dSYM'))
            self.assertEqual(release_metadata.digest(extracted_symbols / 'fixture.dSYM/Contents/Resources/DWARF/fixture'), metadata['dsym_sha256'])
            self.assertEqual(release_metadata.digest(extracted / 'MacOS/ade-client'), release_metadata.digest(packaged))
            subprocess.run([str(extracted / 'MacOS/ade-client')], check=True)

if __name__ == '__main__':
    unittest.main()
