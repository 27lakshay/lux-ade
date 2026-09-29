#!/usr/bin/env python3
"""Install pinned, checksum-verified development tools into this project's .ade."""
import argparse
import json
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import tempfile
import zipfile
import stat
from bootstrap import ROOT, extract, fetch

def select_tools(configuration, names):
    unknown = set(names) - configuration.keys()
    if unknown:
        raise ValueError('Unknown tools: ' + ', '.join(sorted(unknown)))
    return list(dict.fromkeys(names)) if names else [name for name, tool in configuration.items() if not tool.get('optional', False)]



def extract_executable(archive, temporary, name, specification):
    member = specification.get('member')
    if member:
        path = PurePosixPath(member)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('Invalid tool archive member')
        with zipfile.ZipFile(archive) as bundle:
            info = bundle.getinfo(member)
            if info.is_dir() or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError('Tool archive member must be a regular file')
            candidate = temporary / name
            with bundle.open(info) as source, candidate.open('wb') as destination:
                shutil.copyfileobj(source, destination)
        return candidate
    extract(archive, temporary)
    candidates = [p for p in temporary.rglob(name) if p.is_file()]
    if len(candidates) != 1:
        raise RuntimeError('Expected one executable in ' + name + ' archive')
    return candidates[0]


def main():
    configuration = json.loads(Path(__file__).with_name('tools.json').read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tools', nargs='*', help='Install only named tools; defaults omit optional tools')
    parser.add_argument('--list', action='store_true', help='Show selection without installing')
    args = parser.parse_args()
    try:
        names = select_tools(configuration, args.tools)
    except ValueError as error:
        parser.error(str(error))
    if args.list:
        for name in names:
            print(name, configuration[name]['version'])
        return
    state = ROOT / '.ade'
    cache = state / 'downloads'; cache.mkdir(parents=True, exist_ok=True)
    binaries = state / 'tools/bin'; binaries.mkdir(parents=True, exist_ok=True)
    host = platform.system() + '-' + platform.machine()
    for name in names:
        tool = configuration[name]
        if host not in tool['archives']:
            raise SystemExit(f'No pinned binary for {host}; install {name} {tool["version"]} from source with cargo install --locked')
        archive = fetch(tool['archives'][host], cache)
        with tempfile.TemporaryDirectory(dir=state) as directory:
            temporary = Path(directory)
            candidate = extract_executable(archive, temporary, name, tool['archives'][host])
            candidate.chmod(0o755)
            output = subprocess.check_output([str(candidate), '--version'], text=True)
            if tool['version'] not in output.split():
                raise RuntimeError('Unexpected tool version: ' + output)
            staged = binaries / (name + '.next')
            shutil.copy2(candidate, staged)
            staged.replace(binaries / name)
            print(output.strip())
    print('Use PATH="' + str(binaries) + ':$PATH" or scripts/check.sh')

if __name__ == '__main__':
    main()
