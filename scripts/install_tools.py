#!/usr/bin/env python3
"""Install pinned, checksum-verified development tools into this project's .ade."""
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
from bootstrap import ROOT, extract, fetch

def main():
    configuration = json.loads(Path(__file__).with_name('tools.json').read_text())
    state = ROOT / '.ade'
    cache = state / 'downloads'; cache.mkdir(parents=True, exist_ok=True)
    binaries = state / 'tools/bin'; binaries.mkdir(parents=True, exist_ok=True)
    host = platform.system() + '-' + platform.machine()
    for name, tool in configuration.items():
        if host not in tool['archives']:
            raise SystemExit(f'No pinned binary for {host}; install {name} {tool["version"]} from source with cargo install --locked')
        archive = fetch(tool['archives'][host], cache)
        with tempfile.TemporaryDirectory(dir=state) as directory:
            temporary = Path(directory)
            extract(archive, temporary)
            candidates = [p for p in temporary.rglob(name) if p.is_file()]
            if len(candidates) != 1:
                raise RuntimeError('Expected one executable in ' + name + ' archive')
            candidate = candidates[0]
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
