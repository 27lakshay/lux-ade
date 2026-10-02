#!/usr/bin/env python3
"""Assemble a relocatable development app. Signing is a separate explicit step."""
import argparse
import json
import platform
from rust_notices import collect as collect_rust_notices
from provider_notices import collect as collect_provider_notices
from native_notices import collect as collect_native_notices
from release_metadata import BINARIES, build_identity, digest, notices, preserve_symbols
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def replace_tree(source, destination, **options):
    # Stage a complete tree so removed dependencies cannot survive into a new bundle.
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        staged = Path(temporary) / 'new'
        shutil.copytree(source, staged, **options)
        old = Path(temporary) / 'old'
        if destination.exists():
            destination.rename(old)
        try:
            staged.rename(destination)
        except BaseException:
            if old.exists():
                old.rename(destination)
            raise


def copy_providers(source, destination):
    """Keep pnpm's self-contained graph without multiplying every linked package."""
    source = source.resolve()
    for entry in source.rglob('*'):
        if entry.is_symlink():
            link = os.readlink(entry)
            if os.path.isabs(link) or not entry.resolve().is_relative_to(source):
                raise RuntimeError('Provider dependency link escapes the package: ' + str(entry))
            if not entry.exists():
                raise RuntimeError('Provider dependency link is broken: ' + str(entry))

    def exclusions(directory, names):
        relative = Path(directory).relative_to(source)
        # Never guess which third-party code/assets/native modules are optional.
        # Provider-owned tests and transient caches are not runtime resources.
        excluded = {name for name in names if name in ('__pycache__', '.DS_Store')}
        if 'node_modules' not in relative.parts:
            excluded.update(name for name in names if name == '.cache')
            excluded.update(name for name in names if name.endswith(('.test.mjs', '.log', '.pyc')))
            excluded.update(name for name in names if name in ('fake-sdk.mjs', 'native-tui-fixture.mjs', 'mock-cli.mjs', 'transport-fixture.mjs'))
        return excluded

    replace_tree(source, destination, symlinks=True, ignore=exclusions)
    # pnpm's Unix command shims contain absolute NODE_PATH values. Keep the
    # dependency graph internal after relocation rather than falling back to the
    # developer's checkout. Regular package files are never rewritten.
    for entry in destination.rglob('*'):
        if entry.parent.name == '.bin' and entry.is_file() and not entry.is_symlink():
            data = entry.read_text()
            if str(source) in data:
                if not data.startswith('#!/bin/sh') or 'basedir=' not in data:
                    raise RuntimeError('Unsupported non-relocatable provider shim: ' + str(entry))
                original_parent = source / entry.relative_to(destination).parent
                relative_root = os.path.relpath(source, original_parent)
                entry.write_text(data.replace(str(source), '${basedir}/' + relative_root))
    for entry in destination.rglob('*'):
        if entry.is_symlink() and (not entry.exists() or not entry.resolve().is_relative_to(destination.resolve())):
            raise RuntimeError('Packaged dependency link does not resolve internally: ' + str(entry))


def stage_providers(destination):
    """Make self-contained provider trees from the shared workspace lockfile."""
    destination.mkdir(parents=True, exist_ok=True)
    for name, package in (('claude', 'ade-claude-adapter'), ('codex', 'ade-codex-worker'), ('omp', 'ade-omp-bridge')):
        subprocess.run(['pnpm', '--filter', package, 'deploy',
                        '--config.inject-workspace-packages=true', '--prod',
                        '--frozen-lockfile', '--ignore-scripts', str(destination / name)],
                       cwd=ROOT, check=True)
        # Deploy rewrites dependency specifiers with peer suffixes. Runtime identity
        # and the distribution manifest must retain the source declaration.
        shutil.copy2(ROOT / 'providers' / name / 'package.json', destination / name / 'package.json')
    for source in ROOT.joinpath('providers').iterdir():
        if source.name in ('claude', 'codex', 'omp'):
            continue
        target = destination / source.name
        if source.is_dir():
            shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        elif source.is_file():
            shutil.copy2(source, target)


def package(profile, destination):
    target = Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'target')) / profile
    resources = destination / 'Contents/Resources'
    binaries = destination / 'Contents/MacOS'
    binaries.mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)
    identity, source_hashes = build_identity(target)
    manifest = {'format_version': 1, 'build_id': identity, 'profile': profile,
                'architecture': platform.machine(), 'binaries': {},
                'cargo_lock_sha256': digest(ROOT / 'Cargo.lock'),
                'native_dependencies_sha256': digest(ROOT / 'native/dependencies.json')}
    symbol_directory = ROOT / 'dist/symbols' / identity
    for name in BINARIES:
        source = target / name
        if not source.is_file():
            raise RuntimeError('Build the workspace first; missing ' + str(source))
        temporary = binaries / (name + '.next')
        shutil.copy2(source, temporary)
        symbols = preserve_symbols(source, temporary, symbol_directory) if profile == 'release' else {}
        manifest['binaries'][name] = {'source_sha256': source_hashes[name],
                                      'packaged_unsigned_sha256': digest(temporary), **symbols}
        temporary.replace(binaries / name)
    ghostty = Path(os.environ.get('GHOSTTY_RESOURCES_DIR', ROOT / '.ade/native/install/share/ghostty'))
    replace_tree(ghostty, resources / 'ghostty')
    terminfo = ghostty.parent / 'terminfo'
    if terminfo.is_dir():
        replace_tree(terminfo, resources / 'terminfo')
    replace_tree(ROOT / 'assets', resources / 'assets')
    shutil.copy2(ROOT / 'assets/terminal.conf', resources / 'terminal.conf')
    (resources / 'scripts').mkdir(exist_ok=True)
    shutil.copy2(ROOT / 'scripts/runtime.py', resources / 'scripts/runtime.py')
    shutil.copy2(ROOT / 'pnpm-lock.yaml', resources / 'pnpm-lock.yaml')
    with tempfile.TemporaryDirectory() as temporary:
        staged = Path(temporary) / 'providers'
        stage_providers(staged)
        copy_providers(staged, resources / 'providers')
    with tempfile.TemporaryDirectory(dir=resources) as temporary:
        notices(ROOT, Path(temporary))
        collect_rust_notices(ROOT, Path(temporary))
        collect_provider_notices(resources / "providers", Path(temporary))
        collect_native_notices(ROOT, resources, Path(temporary))
        replace_tree(Path(temporary), resources / 'third-party')
    (resources / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if profile == 'release':
        (symbol_directory / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    info = {'CFBundleIdentifier':'dev.lux.ade', 'CFBundleName':'lux-ade',
            'CFBundleExecutable':'ade-client', 'CFBundlePackageType':'APPL',
            'CFBundleShortVersionString':'0.1.0', 'CFBundleVersion':'1',
            'NSHighResolutionCapable':True, 'LSMinimumSystemVersion':'14.0'}
    (destination / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    subprocess.run(['plutil', '-lint', str(destination / 'Contents/Info.plist')], check=True)
    print(destination)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=('debug','release'), default='debug')
    parser.add_argument('--destination', type=Path, default=ROOT / 'lux-ade.app')
    args = parser.parse_args()
    package(args.profile, args.destination.resolve())
