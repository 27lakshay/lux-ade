"""Transfer only declared immutable build outputs between compatible CI jobs."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import subprocess
import tarfile
import tempfile

OUTPUTS = {
    'javascript': ['packages/contracts/dist', 'packages/client/dist', 'apps/cli/dist', 'apps/desktop/out'],
    'native': ['target/debug/ade-daemon', 'target/debug/ade-control', 'target/debug/ade-runtime'],
}
REQUIRED = {
    'javascript': ['packages/contracts/dist/index.js', 'packages/client/dist/index.js', 'apps/cli/dist/index.js', 'apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs', 'apps/desktop/out/renderer/index.html'],
    'native': OUTPUTS['native'],
}

def command(root, *args):
    return subprocess.check_output(args, cwd=root, text=True).strip()

def identity(root):
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).split(b'\0')
    digest = hashlib.sha256()
    for name in sorted(set(names) - {b''}):
        path = root / os.fsdecode(name)
        digest.update(name + b'\0')
        if path.is_file():
            digest.update(path.read_bytes())
        digest.update(b'\0')
    return {
        'revision': command(root, 'git', 'rev-parse', 'HEAD'),
        'sourceSha256': digest.hexdigest(),
        'platform': platform.system(), 'architecture': platform.machine(),
        'osMajor': platform.mac_ver()[0].split('.')[0] if platform.system() == 'Darwin' else platform.release(),
        'node': command(root, 'node', '--version'), 'pnpm': command(root, 'pnpm', '--version'),
        'rust': command(root, 'rustc', '--version'),
        'nativeProfile': 'debug', 'nativeFeatures': ['ade-runtime/native-terminal'],
        'backendCommand': json.loads((root / 'package.json').read_text())['scripts']['build:backend'],
        'nativeEnvironment': {name: os.environ.get(name, '') for name in [
            'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'SDKROOT',
            'MACOSX_DEPLOYMENT_TARGET', 'CARGO_BUILD_TARGET',
        ]},
        'clang': command(root, 'clang', '--version') if platform.system() == 'Darwin' else None,
        'sdk': command(root, 'xcrun', '--show-sdk-version') if platform.system() == 'Darwin' else None,
        'rustflags': os.environ.get('RUSTFLAGS', ''),
        'encodedRustflags': os.environ.get('CARGO_ENCODED_RUSTFLAGS', ''),
    }

def allowed(name, group):
    path = PurePosixPath(name)
    return not path.is_absolute() and '..' not in path.parts and any(name == prefix or name.startswith(prefix + '/') for prefix in OUTPUTS[group])

def file_record(path):
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'mode': path.stat().st_mode & 0o777, 'size': path.stat().st_size}

def pack(root, group, directory, build_identity):
    for name in REQUIRED[group]:
        if not (root / name).is_file():
            raise ValueError('Missing build output: ' + name)
    files = {}
    for prefix in OUTPUTS[group]:
        path = root / prefix
        for parent in [path, *path.parents]:
            if parent == root:
                break
            if parent.is_symlink():
                raise ValueError('Build output contains a symbolic link: ' + str(parent))
        for item in sorted(path.rglob('*')) if path.is_dir() else [path]:
            if item.is_symlink():
                raise ValueError('Build output must not be a symbolic link: ' + str(item))
            if item.is_file():
                files[item.relative_to(root).as_posix()] = file_record(item)
    directory.mkdir(parents=True, exist_ok=False)
    with tarfile.open(directory / 'outputs.tar.gz', 'w:gz') as archive:
        for name in files:
            archive.add(root / name, arcname=name, recursive=False)
    manifest = {'version': 1, 'group': group, 'identity': build_identity, 'files': files}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

def restore(root, group, directory, expected_identity):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('version') != 1 or manifest.get('group') != group or manifest.get('identity') != expected_identity:
        raise ValueError('Build artifact identity mismatch')
    files = manifest.get('files', {})
    if not isinstance(files, dict) or not all(name in files for name in REQUIRED[group]):
        raise ValueError('Build artifact is missing required outputs')
    if not all(allowed(name, group) for name in files):
        raise ValueError('Build artifact contains undeclared output paths')
    # Validate the entire archive before replacing any build output.
    with tempfile.TemporaryDirectory(prefix='ade-build-restore-') as temporary:
        staging = Path(temporary)
        with tarfile.open(directory / 'outputs.tar.gz', 'r:gz') as archive:
            members = archive.getmembers()
            names = [member.name for member in members]
            if len(names) != len(set(names)) or set(names) != set(files):
                raise ValueError('Archive members do not match manifest')
            for member in members:
                if not member.isfile() or not allowed(member.name, group) or member.size != files[member.name]['size']:
                    raise ValueError('Invalid archive member: ' + member.name)
            archive.extractall(staging, filter='data')
        for name, expected in files.items():
            if file_record(staging / name) != expected:
                raise ValueError('Build output integrity mismatch: ' + name)
            destination = root / name
            if any(parent.is_symlink() for parent in [destination, *destination.parents] if parent != root.parent):
                raise ValueError('Destination contains a symbolic link: ' + name)
        for name in files:
            destination = root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.ade-build-', delete=False) as output:
                replacement = Path(output.name)
                output.write((staging / name).read_bytes())
            try:
                replacement.chmod(files[name]['mode'])
                replacement.replace(destination)
            finally:
                replacement.unlink(missing_ok=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['pack', 'restore'])
    parser.add_argument('group', choices=OUTPUTS)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    root = Path.cwd().resolve()
    operation = pack if args.action == 'pack' else restore
    operation(root, args.group, args.directory.resolve(), identity(root))
