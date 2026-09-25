"""Release identity, matching dSYMs and a bounded third-party source inventory."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

BINARIES = ('ade-client', 'ade-daemon', 'ade-runtime', 'ade-attach')

def digest(filename):
    checksum = hashlib.sha256()
    with Path(filename).open('rb') as reader:
        for block in iter(lambda: reader.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()

def build_identity(target):
    hashes = {name: digest(target / name) for name in BINARIES}
    identity = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()[:24]
    return identity, hashes

def uuids(filename):
    output = subprocess.check_output(['xcrun', 'dwarfdump', '--uuid', str(filename)], text=True)
    result = sorted(re.findall(r'UUID: ([A-Fa-f0-9-]+) \(([^)]+)\)', output))
    if not result:
        raise RuntimeError('No Mach-O UUID found: ' + str(filename))
    return result

def preserve_symbols(source, packaged, directory):
    """Fail closed before stripping if a matching symbol bundle cannot be produced."""
    directory.mkdir(parents=True, exist_ok=True)
    dsym = directory / (source.name + '.dSYM')
    existing = source.with_name(source.name + '.dSYM')
    if existing.is_dir() and uuids(existing) == uuids(source):
        shutil.copytree(existing, dsym, dirs_exist_ok=True)
    else:
        result = subprocess.run(['xcrun', 'dsymutil', str(source), '-o', str(dsym)],
                                capture_output=True, text=True, check=True)
        if any(message in result.stderr.lower() for message in
               ('no debug symbols', 'could not find object file', 'unable to open object file')):
            raise RuntimeError('Incomplete debug symbols for ' + source.name + ': ' + result.stderr)
    identifiers = uuids(source)
    if uuids(dsym) != identifiers:
        raise RuntimeError('dSYM UUID does not match ' + source.name)
    dwarf = dsym / 'Contents/Resources/DWARF' / source.name
    if not dwarf.is_file() or dwarf.stat().st_size == 0:
        raise RuntimeError('Missing DWARF data for ' + source.name)
    subprocess.run(['xcrun', 'strip', '-S', str(packaged)], check=True)
    if uuids(packaged) != identifiers:
        raise RuntimeError('Stripped binary UUID changed: ' + source.name)
    return {'uuids': identifiers, 'dsym_sha256': digest(dwarf)}

def notices(root, destination):
    """Retain native/vendor notices without claiming a transitive license audit."""
    sources = json.loads((root / 'native/dependencies.json').read_text())['sources']
    inventory = []
    text = ['# Third-party source notices', '',
            'This inventory preserves license and notice files present in lux-ade’s pinned native',
            'source trees. It is not a complete transitive Rust/provider license audit and',
            'does not select a license for lux-ade. Review distribution obligations before release.', '',
            'The packaged Rust inventory is described separately in `RUST_DEPENDENCY_NOTICES.md`',
            'and `rust-dependency-inventory.json`. Installed provider records are in',
            '`PROVIDER_DEPENDENCY_NOTICES.md` and `provider-dependency-inventory.json`.',
            'Native/resource evidence is in `NATIVE_RESOURCE_NOTICES.md` and',
            '`native-resource-inventory.json`; exact linkage and obligations remain unreviewed.', '']
    for name, source in sources.items():
        base = root / '.ade/vendor' / name
        if not base.is_dir():
            raise RuntimeError('Bootstrap dependencies before packaging: ' + str(base))
        text.extend(['## ' + name, '', 'Source: ' + source['url'],
                     'Archive SHA-256: `' + source['sha256'] + '`', ''])
        found = []
        for file in sorted(base.rglob('*')):
            if not file.is_file() or any(part in ('.git', '.zig-cache', 'target', 'node_modules') for part in file.relative_to(base).parts):
                continue
            title = file.name.upper()
            if not title.startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT')):
                continue
            relative = file.relative_to(base)
            data = file.read_bytes()
            entry = {'source': name, 'path': str(relative), 'sha256': hashlib.sha256(data).hexdigest()}
            inventory.append(entry)
            found.append(str(relative))
            output = destination / 'licenses' / name / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)
        text.extend(' - `licenses/' + name + '/' + filename + '`' for filename in found)
        text.append('')
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'THIRD_PARTY_NOTICES.md').write_text('\n'.join(text))
    (destination / 'third-party-inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
    return inventory
