"""Inventory installed pnpm package trees without fetching or choosing licenses."""
import hashlib
import json
import os
from pathlib import Path

PREFIXES = ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def package_location(path):
    return path.parent.name == 'node_modules' or (
        path.parent.name.startswith('@') and path.parent.parent.name == 'node_modules')


def collect(providers, destination):
    providers, destination = Path(providers).resolve(), Path(destination)
    manifests, aliases, locks = {}, {}, []
    workspace_lock = providers.parent / 'pnpm-lock.yaml'
    if workspace_lock.is_file():
        output = Path('workspace-lockfile') / workspace_lock.name
        (destination / output).parent.mkdir(parents=True, exist_ok=True)
        data = workspace_lock.read_bytes()
        (destination / output).write_bytes(data)
        for provider in sorted(providers.iterdir()):
            if (provider / 'package.json').is_file():
                locks.append({'provider': provider.name, 'path': str(output), 'sha256': digest(data)})
    # Walk physical directories only. Inspect links separately, never recurse through them.
    for directory, directories, files in os.walk(providers, followlinks=False):
        base = Path(directory)
        directories[:] = sorted(d for d in directories if d not in ('.git', '__pycache__', '.cache'))
        for name in directories + files:
            path = base / name
            if path.is_symlink():
                resolved = path.resolve()
                if not resolved.is_relative_to(providers) or not path.exists():
                    raise RuntimeError('Provider inventory link escapes or is broken: ' + str(path.relative_to(providers)))
                if package_location(path) and (resolved / 'package.json').is_file():
                    aliases.setdefault(resolved, set()).add(str(path.relative_to(providers)))
        if 'package.json' in files and (package_location(base) or base.parent == providers):
            manifests[base.resolve()] = json.loads((base / 'package.json').read_text())
        if not workspace_lock.is_file() and 'pnpm-lock.yaml' in files and base.parent == providers:
            source = base / 'pnpm-lock.yaml'
            output = Path('provider-lockfiles') / base.name / source.name
            (destination / output).parent.mkdir(parents=True, exist_ok=True)
            data = source.read_bytes()
            (destination / output).write_bytes(data)
            locks.append({'provider': base.name, 'path': str(output), 'sha256': digest(data)})
    keys = {base: str(base.relative_to(providers)) for base in manifests}

    def resolve(base, name):
        # Mirror package-directory resolution using real paths, including pnpm's sibling links.
        current = base
        while current.is_relative_to(providers):
            candidate = current / 'node_modules' / name
            if candidate.exists():
                return keys.get(candidate.resolve())
            current = current.parent
        return None

    entries = []
    for base, manifest in sorted(manifests.items(), key=lambda item: keys[item[0]]):
        provider = base.relative_to(providers).parts[0]
        entry = {'id': keys[base], 'provider': provider, 'name': manifest.get('name'),
                 'version': manifest.get('version'), 'provider_root': base.parent == providers,
                 'license_declaration': manifest.get('license'), 'legacy_licenses': manifest.get('licenses'),
                 'repository': manifest.get('repository'), 'homepage': manifest.get('homepage'),
                 'declared_resolved_source': manifest.get('_resolved'),
                 'declared_integrity': manifest.get('_integrity'),
                 'manifest_sha256': digest((base / 'package.json').read_bytes()),
                 'aliases': sorted(aliases.get(base, [])), 'dependencies': [], 'notices': [], 'issues': []}
        # The installed location and copied lockfile are source evidence even when npm
        # omits _resolved/_integrity. Do not invent a registry URL from a package name.
        entry['lockfile'] = next((lock['path'] for lock in locks if lock['provider'] == provider), None)
        if not entry['lockfile'] and not entry['provider_root']:
            entry['issues'].append('No pnpm lockfile found')
        if not entry['license_declaration'] and not entry['legacy_licenses']:
            entry['issues'].append('No license declaration')
        if isinstance(entry['license_declaration'], (dict, list)) or entry['legacy_licenses']:
            entry['issues'].append('Legacy or structured declaration requires review')
        for kind in ('dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'):
            for name, requested in sorted(manifest.get(kind, {}).items()):
                resolved = resolve(base, name)
                entry['dependencies'].append({'name': name, 'requested': requested, 'kind': kind,
                                              'resolved': resolved,
                                              'optional_peer': bool(manifest.get('peerDependenciesMeta', {}).get(name, {}).get('optional'))})
                if resolved is None and kind == 'dependencies':
                    entry['issues'].append('Declared dependency not resolved: ' + name)
        candidates = []
        for directory, directories, files in os.walk(base, followlinks=False):
            directories[:] = sorted(d for d in directories if d not in ('node_modules', '.git', '.cache', '__pycache__'))
            candidates += [Path(directory) / name for name in files if name.upper().startswith(PREFIXES)]
        declaration = entry['license_declaration']
        if isinstance(declaration, str) and declaration.upper().startswith('SEE LICENSE IN '):
            specified = base / declaration[len('SEE LICENSE IN '):].strip()
            if not specified.resolve().is_relative_to(base):
                entry['issues'].append('Declared license path escapes package root')
            elif specified.is_file():
                candidates.append(specified)
            else:
                entry['issues'].append('Declared license file is missing')
        for source in sorted(set(candidates)):
            if not source.resolve().is_relative_to(base):
                entry['issues'].append('Notice outside package root not copied: ' + str(source.relative_to(base)))
                continue
            data = source.read_bytes()
            relative = source.relative_to(base)
            output = Path('licenses/providers') / digest(keys[base].encode())[:20] / relative
            (destination / output).parent.mkdir(parents=True, exist_ok=True)
            (destination / output).write_bytes(data)
            entry['notices'].append({'source_path': str(relative), 'path': str(output), 'sha256': digest(data), 'bytes': len(data)})
            if not data.strip():
                entry['issues'].append('Empty notice: ' + str(relative))
        if not entry['notices']:
            entry['issues'].append('No notice text found; declarations alone are not retained license text')
        entry['review'] = 'unresolved' if entry['issues'] else 'text-retained-unreviewed'
        entries.append(entry)
    result = {'format': 1, 'scope': 'All physical installed packages in provider node_modules plus provider roots. '
              'Symlink aliases share one entry. Includes installed optional/dev packages and potentially stale packages; '
              'not a runtime reachability or license clearance assertion. Missing optional/peer/dev resolutions are recorded '
              'on edges and can be normal for platform-specific production installs. External CLI/runtime binaries excluded.',
              'provenance_limits': 'The exact workspace lockfile is retained with its hash. Registry integrity/source entries '
              'remain in those lockfiles; this collector does not parse YAML or infer registry URLs. '
              'Manifest declarations are untrusted evidence, not verified ownership or license compatibility.',
              'lockfiles': sorted(locks, key=lambda lock: lock['provider']), 'packages': entries}
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'provider-dependency-inventory.json').write_text(json.dumps(result, indent=2) + '\n')
    lines = ['# Provider dependency notices', '', result['scope'], '', result['provenance_limits'], '',
             'No license alternatives or lux-ade project license are selected.', '',
             '| Package | Provider | Declared license | Review |', '| --- | --- | --- | --- |']
    for entry in entries:
        values = [str(entry['name']) + ' ' + str(entry['version']), entry['provider'],
                  json.dumps(entry['license_declaration'], ensure_ascii=False),
                  '; '.join(entry['issues'] or ['Text retained; terms not reviewed'])]
        lines.append('| ' + ' | '.join(value.replace('|', '\\|').replace('\n', ' ') for value in values) + ' |')
    (destination / 'PROVIDER_DEPENDENCY_NOTICES.md').write_text('\n'.join(lines) + '\n')
    return result
