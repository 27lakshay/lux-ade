#!/usr/bin/env python3
"""Fetch verified native sources; never overwrite an existing dependency checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def run(*args, cwd=None):
    environment = os.environ.copy()
    if args[:2] == ('git', 'apply'):
        # Extracted sources are not checkouts. Parent repository discovery makes
        # git apply silently skip paths under a nested temporary directory.
        for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'):
            environment.pop(key, None)
        environment['GIT_CEILING_DIRECTORIES'] = str(Path(cwd).resolve().parent)
    subprocess.run([str(x) for x in args], cwd=cwd, env=environment, check=True)

def fetch(entry, cache):
    archive = cache / entry['sha256']
    if not archive.exists():
        with urllib.request.urlopen(entry['url'], timeout=120) as source:
            data = source.read()
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise RuntimeError('Checksum mismatch: ' + entry['url'])
        archive.write_bytes(data)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != entry['sha256']:
        raise RuntimeError('Corrupt cached archive: ' + str(archive))
    return archive

def extract(archive, output):
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target = (output / member.name).resolve()
            if not target.is_relative_to(output.resolve()) or member.isdev():
                raise RuntimeError('Unsafe archive member: ' + member.name)
            if member.issym() or member.islnk():
                link = (target.parent if member.issym() else output.resolve()) / member.linkname
                if not link.resolve().is_relative_to(output.resolve()):
                    raise RuntimeError('Unsafe archive link: ' + member.name)
        # No links exist while regular members are extracted; validated links go last.
        regular = [m for m in tar.getmembers() if not (m.issym() or m.islnk())]
        links = [m for m in tar.getmembers() if m.issym() or m.islnk()]
        tar.extractall(output, members=regular, filter="data")
        tar.extractall(output, members=links, filter="data")

def source_fingerprint(entry, patch):
    return {'format_version': 1, 'archive_sha256': entry['sha256'],
            'patch_sha256': hashlib.sha256(patch.read_bytes()).hexdigest() if patch.exists() else None}


def source_files(directory, renderer=False):
    ignored = {'.git', '.zig-cache', 'zig-out', 'target', '__pycache__'}
    result = {}
    for file in directory.rglob('*'):
        relative = file.relative_to(directory)
        if (renderer and str(relative).startswith('macos/GhosttyKit.xcframework/')) or any(part in ignored for part in relative.parts):
            continue
        if file.is_file():
            # Existing copies may materialize source license symlinks. Verify their
            # bytes too; both forms preserve the same source text.
            result[str(relative)] = hashlib.sha256(file.read_bytes()).hexdigest()
        elif file.is_symlink():
            result[str(relative)] = 'link:' + os.readlink(file)
    return result


def install_source(name, entry, state, cache, patch, destination=None):
    destination = destination or state / 'vendor' / name
    metadata = state / 'source-metadata' / (name + '.json')
    expected = source_fingerprint(entry, patch)
    if destination.exists() and metadata.is_file():
        if json.loads(metadata.read_text()) != expected:
            raise RuntimeError('Pinned source or patch changed for ' + name + '. Preserve local edits, '
                               'move ' + str(destination) + ' aside, then rerun bootstrap. '
                               'The existing dependency was not overwritten.')
        print('Keeping fingerprint-matched dependency:', destination)
        return
    archive = fetch(entry, cache)
    with tempfile.TemporaryDirectory(dir=state) as temporary:
        temporary = Path(temporary)
        extract(archive, temporary)
        source = temporary / entry['subdirectory']
        if patch.exists():
            run('git', 'apply', '--check', patch, cwd=source)
            run('git', 'apply', patch, cwd=source)
        if destination.exists():
            actual_files, expected_files = source_files(destination, name == 'ghostty-renderer'), source_files(source)
            differences = [name for name in sorted(actual_files.keys() | expected_files.keys())
                           if actual_files.get(name) != expected_files.get(name)]
            if differences:
                raise RuntimeError('Unstamped dependency differs from pinned source: ' + str(destination)
                                   + '. Preserve local edits and move it aside before bootstrap. '
                                   + 'First differing paths: ' + ', '.join(differences[:8]))
            print('Verified existing dependency against fetched source:', destination)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(source, destination)
        metadata.parent.mkdir(parents=True, exist_ok=True)
        pending = metadata.with_suffix('.json.next')
        pending.write_text(json.dumps(expected, indent=2) + '\n')
        pending.replace(metadata)


def setup(root, sources_only):
    state = root / '.ade'
    cache = state / 'downloads'
    cache.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / 'native/dependencies.json').read_text())
    for name, entry in manifest['sources'].items():
        install_source(name, entry, state, cache, ROOT / 'patches' / (name + '.patch'))
    if sources_only:
        return
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('Native renderer currently supports Apple Silicon macOS only; use --sources-only for core work')
    run('xcrun', '--find', 'metal')
    zig = Path(os.environ.get('ADE_ZIG_BIN', state / 'toolchains/zig/zig'))
    if not zig.exists():
        archive = fetch(manifest['zig'], cache)
        with tempfile.TemporaryDirectory(dir=state) as temporary:
            temporary = Path(temporary)
            extract(archive, temporary)
            zig.parent.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(temporary / manifest['zig']['subdirectory'], zig.parent)
    version = subprocess.check_output([str(zig), 'version'], text=True).strip()
    if version != '0.16.0':
        raise RuntimeError('Expected Zig 0.16.0, got ' + version)
    native = state / 'native'
    native.mkdir(exist_ok=True)
    renderer = native / 'ghostty'
    install_source('ghostty-renderer', manifest['sources']['libghostty-vt'], state, cache,
                   ROOT / 'patches/ghostty.patch', destination=renderer)
    vt = native / 'vt'
    run(zig, 'build', '-Demit-lib-vt', '-Doptimize=ReleaseFast', '-Demit-xcframework=false', '--prefix', vt,
        cwd=state / 'vendor/libghostty-vt')
    (renderer / 'macos').mkdir(exist_ok=True)
    run(zig, 'build', '-Dapp-runtime=none', '-Demit-xcframework=true', '-Dxcframework-target=native',
        '-Demit-macos-app=false', '-Doptimize=ReleaseFast', '-Dstrip=false', '-Demit-docs=false',
        '-Demit-helpgen=false', '-Di18n=false', '--prefix', native / 'install', cwd=renderer)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources-only', action='store_true')
    parser.add_argument('--root', type=Path, default=ROOT, help='Alternate clean dependency destination for verification')
    args = parser.parse_args()
    setup(args.root.resolve(), args.sources_only)
