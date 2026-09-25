"""Record resolved Cargo provenance and available notices, without license decisions."""
import hashlib
import json
from pathlib import Path
import subprocess

NOTICE_PREFIXES = ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT')
EXCLUDED = {'.git', 'target', 'node_modules', '.zig-cache', '__pycache__'}


def resolve_metadata(root):
    host = next(line.split(': ', 1)[1] for line in subprocess.check_output(
        ['rustc', '-vV'], text=True).splitlines() if line.startswith('host: '))
    command = ['cargo', 'metadata', '--locked', '--offline', '--format-version', '1',
               '--filter-platform', host, '--features', 'ade-runtime/native-terminal']
    metadata = json.loads(subprocess.check_output(command, cwd=root, text=True))
    return metadata, {'target': host, 'command': command,
                      'selection': 'All workspace members; default features plus ade-runtime/native-terminal',
                      'limits': 'Conservative resolved graph including normal, build and dev dependencies. '
                      'Target filtering uses the packaging host. This is not a linked-binary inventory; '
                      'Cargo feature resolution may include features from development dependencies.'}


def inventory(root, destination, metadata, scope):
    root, destination = Path(root).resolve(), Path(destination)
    packages = {p['id']: p for p in metadata['packages']}
    members = set(metadata['workspace_members'])
    nodes = {n['id']: n for n in metadata['resolve']['nodes']}
    pins = json.loads((root / 'native/dependencies.json').read_text())['sources']

    def provenance(package):
        if package['source']:
            return {'source': package['source']}
        base = Path(package['manifest_path']).parent.resolve()
        try:
            relative = str(base.relative_to(root))
        except ValueError:
            relative = 'external-path/' + base.name
        value = {'source': 'path:' + relative}
        for name, pin in pins.items():
            if base == root / '.ade/vendor' / name or (root / '.ade/vendor' / name) in base.parents:
                value['archive'] = pin
                patch = root / 'patches' / (name + '.patch')
                value['patch_sha256'] = hashlib.sha256(patch.read_bytes()).hexdigest() if patch.exists() else None
        return value

    origins = {key: provenance(package) for key, package in packages.items()}
    identifiers = {key: p['name'] + '@' + p['version'] + '#' + origins[key]['source']
                   for key, p in packages.items()}
    entries = []
    for key in sorted(nodes, key=lambda key: identifiers[key]):
        package = packages[key]
        base = Path(package['manifest_path']).parent.resolve()
        entry = {'id': identifiers[key], 'name': package['name'], 'version': package['version'],
                 'workspace_member': key in members, **origins[key],
                 'repository': package.get('repository'), 'license_expression': package.get('license'),
                 'declared_license_file': package.get('license_file'),
                 'features': sorted(nodes[key].get('features', [])), 'notices': [], 'issues': []}
        if 'archive' in entry:
            entry['related_native_notices'] = next(
                'licenses/' + name for name, pin in pins.items() if pin == entry['archive'])
        vcs_file = base / '.cargo_vcs_info.json'
        if vcs_file.is_file():
            entry['cargo_vcs_info'] = json.loads(vcs_file.read_text())
        checksum_file = base / '.cargo-checksum.json'
        if checksum_file.is_file():
            entry['registry_package_checksum'] = json.loads(checksum_file.read_text()).get('package')
        if not entry['license_expression'] and not entry['declared_license_file']:
            entry['issues'].append('No license expression or license-file declared')
        candidates = set()
        if not base.is_dir():
            entry['issues'].append('Resolved source directory unavailable')
        else:
            candidates.update(file for file in base.rglob('*') if
                              not EXCLUDED.intersection(file.relative_to(base).parts)
                              and file.name.upper().startswith(NOTICE_PREFIXES) and file.is_file())
        declared = entry['declared_license_file']
        if declared:
            candidate = base / declared
            if candidate.is_file():
                candidates.add(candidate)
            else:
                entry['issues'].append('Declared license-file is missing')
        slug = package['name'] + '-' + package['version'] + '-' + hashlib.sha256(
            identifiers[key].encode()).hexdigest()[:12]
        for file in sorted(candidates):
            # Do not follow a malicious or accidental notice symlink out of a package.
            if not file.resolve().is_relative_to(base):
                entry['issues'].append('Notice outside package root was not copied: ' + file.name)
                continue
            relative = file.relative_to(base)
            data = file.read_bytes()
            if not data.strip():
                entry['issues'].append('Empty notice file: ' + str(relative))
            output = Path('licenses/rust') / slug / relative
            (destination / output).parent.mkdir(parents=True, exist_ok=True)
            (destination / output).write_bytes(data)
            entry['notices'].append({'source_path': str(relative), 'path': str(output),
                                     'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        if not entry['notices']:
            entry['issues'].append('No license or notice text found; an SPDX expression alone is not retained text')
        entry['review'] = ('unresolved' if entry['issues'] else 'text-retained-unreviewed')
        entry['dependencies'] = sorted([
            {'id': identifiers[dependency['pkg']], 'name': dependency['name'],
             'kinds': [{'kind': kind['kind'] or 'normal', 'target': kind.get('target')}
                       for kind in dependency['dep_kinds']]}
            for dependency in nodes[key].get('deps', [])], key=lambda edge: (edge['id'], edge['name']))
        entries.append(entry)
    result = {'format': 1, 'scope': scope,
              'cargo_lock_sha256': hashlib.sha256((root / 'Cargo.lock').read_bytes()).hexdigest(),
              'license_review': 'No SPDX alternatives selected or compatibility conclusions made. '
              'Retained texts can cover nested components and require human attribution review.',
              'packages': entries}
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'rust-dependency-inventory.json').write_text(json.dumps(result, indent=2) + '\n')
    lines = ['# Rust dependency notices', '', scope['limits'], '',
             'No project license or SPDX alternative is selected. Text retention is not license clearance.', '',
             '| Package | Declared license | Review |', '| --- | --- | --- |']
    lines.extend('| ' + p['name'] + ' ' + p['version'] + ' | ' +
                 (p['license_expression'] or '(not declared)').replace('|', '\\|') + ' | ' +
                 '; '.join(p['issues'] or ['Text retained; terms not reviewed']).replace('|', '\\|') + ' |'
                 for p in entries)
    lines += ['', 'Source identities, features, dependency kinds/target predicates and retained text hashes',
              'are in `rust-dependency-inventory.json`. Native and provider inventories have separate scope.', '']
    (destination / 'RUST_DEPENDENCY_NOTICES.md').write_text('\n'.join(lines))
    return result


def collect(root, destination):
    metadata, scope = resolve_metadata(root)
    return inventory(root, destination, metadata, scope)
