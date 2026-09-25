"""Evidence inventory for native inputs/resources; not linker or license clearance."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

PREFIXES = ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT', 'OFL', 'FTL', 'AUTHORS', 'UNLICENSE')
# Narrow extraction of literal URL/hash records. Raw manifests remain authoritative.
DEPENDENCY = re.compile(r'\.(?:@"([^"]+)"|(\w+))\s*=\s*\.\{([^{}]*)\}', re.S)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()


def references(data):
    result = []
    for match in DEPENDENCY.finditer(data.decode('utf-8')):
        fields = dict(re.findall(r'\.(url|hash)\s*=\s*"([^"\n]+)"', match[3]))
        if 'url' in fields and 'hash' in fields:
            result.append({'name': match[1] or match[2], **fields})
    return result


def retain(destination, relative, data):
    output = destination / relative
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    return {'path': str(relative), 'sha256': digest(data), 'bytes': len(data)}


def cached_package(cache, dependency, destination):
    """Read cached Zig tar without extraction or following archive links."""
    result = {**dependency, 'notices': [], 'manifests': [], 'font_files': [], 'issues': []}
    archive = cache / (dependency['hash'] + '.tar.gz')
    if not archive.is_file():
        result['issues'].append('Cached source archive unavailable; linked status not inferred')
        return result, []
    result['cached_archive_sha256'] = file_digest(archive)
    pending = []
    with tarfile.open(archive, 'r:*') as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise RuntimeError('Unsafe Zig cache archive member: ' + member.name)
            notice = path.name.upper().startswith(PREFIXES)
            manifest = path.name == 'build.zig.zon'
            font = path.suffix.lower() in ('.ttf', '.otf', '.woff', '.woff2')
            if not (notice or manifest or font):
                continue
            if not member.isfile():
                result['issues'].append('Non-regular evidence file skipped: ' + member.name)
                continue
            if member.size > 32 * 1024 * 1024:
                result['issues'].append('Evidence file exceeds 32 MiB limit: ' + member.name)
                continue
            with tar.extractfile(member) as source:
                data = source.read()
            if notice:
                if not data.strip():
                    result['issues'].append('Empty notice text: ' + member.name)
                result['notices'].append(retain(destination, Path('licenses/native-cache') / dependency['hash'] / path, data))
            if manifest:
                result['manifests'].append(retain(destination, Path('native-manifests/cache') / dependency['hash'] / path, data))
                pending += references(data)
            if font:
                result['font_files'].append({'source_path': str(path), 'sha256': digest(data), 'bytes': len(data),
                                             'scope': 'Available source font; embedding is not inferred per file'})
    if not result['notices']:
        result['issues'].append('No recognized notice text in cached source archive')
    return result, pending


def supplemental_notices(root, destination):
    base = root / 'native/notices'
    manifest = base / 'provenance.json'
    if not manifest.is_file():
        return {'files': [], 'issues': ['Pinned supplemental notices unavailable']}
    provenance = json.loads(manifest.read_text())
    for entry in provenance['files']:
        source = base / entry['path']
        if not source.resolve().is_relative_to(base.resolve()):
            raise RuntimeError('Supplemental notice escapes its source directory')
        data = source.read_bytes()
        if digest(data) != entry['sha256']:
            raise RuntimeError('Supplemental notice checksum mismatch: ' + entry['path'])
        entry['packaged_path'] = retain(destination, Path('licenses/supplemental') / entry['path'], data)['path']
    retain(destination, Path('native-manifests/supplemental-provenance.json'), manifest.read_bytes())
    return provenance


def collect(root, resources, destination, cache=None):
    root, resources, destination = Path(root).resolve(), Path(resources), Path(destination)
    cache = Path(cache) if cache else Path(os.environ.get('ZIG_GLOBAL_CACHE_DIR', Path.home() / '.cache/zig')) / 'p'
    manifest = json.loads((root / 'native/dependencies.json').read_text())
    source = root / '.ade/vendor/libghostty-vt'
    result = {'format': 1, 'source_pins': manifest['sources'], 'resources': [], 'static_archives': [],
              'manifests': [], 'cached_sources': [], 'icon_source_files': [], 'issues': [],
              'scope': 'Exact packaged loose resources and configured native archive inputs; source candidates from '
              'literal URL/hash entries in retained Zig manifests, including lazy/platform/test dependencies. '
              'Archive member names do not establish which objects a linker selected. Cache presence does not prove linkage. '
              'Native source dependencies/embedded resources may require additional notices; no license choices or clearance.',
              'cache_verification': 'Cache files matched by declared Zig package-hash name; SHA-256 of available archive '
              'recorded. Collector does not recompute Zig package hashes or verify archive origin.'}
    pending = []
    if source.is_dir():
        for path in sorted(source.rglob('build.zig.zon')):
            if any(part in ('.zig-cache', '.git', 'zig-out') for part in path.relative_to(source).parts):
                continue
            data = path.read_bytes()
            result['manifests'].append(retain(destination, Path('native-manifests/ghostty') / path.relative_to(source), data))
            pending += references(data)
        for name in ('src/font/embedded.zig', 'src/build/SharedDeps.zig'):
            path = source / name
            if path.is_file():
                result['manifests'].append(retain(destination, Path('native-manifests/ghostty') / name, path.read_bytes()))
    else:
        result['issues'].append('Pinned Ghostty source unavailable')
    seen = set()
    while pending:
        dependency = pending.pop(0)
        key = dependency['hash']
        if key in ('.', '..') or not re.fullmatch(r'[A-Za-z0-9_.-]+', key):
            raise RuntimeError('Invalid Zig dependency hash')
        if key in seen:
            continue
        if len(seen) >= 1000:
            raise RuntimeError('Native dependency evidence exceeds 1000 cached packages')
        seen.add(key)
        entry, children = cached_package(cache, dependency, destination)
        result['cached_sources'].append(entry)
        pending += children
    result['cached_sources'].sort(key=lambda entry: entry['hash'])
    supplemental = supplemental_notices(root, destination)
    result['supplemental_notices'] = supplemental
    for entry in result['cached_sources']:
        if entry['name'] == 'iterm2_themes' and entry.get('cached_archive_sha256') == supplemental.get('theme_verification', {}).get('cache_sha256'):
            entry['supplemental_provenance'] = supplemental['theme_verification']
            entry['supplemental_notice_paths'] = [file['packaged_path'] for file in supplemental['files'] if file['path'].startswith('themes/')]
            entry['issues'] = [issue for issue in entry['issues'] if issue != 'No recognized notice text in cached source archive']
        if entry['name'] == 'nerd_fonts_symbols_only' and entry['hash'] == supplemental.get('nerd_fonts_package_hash'):
            entry['supplemental_notice_paths'] = [file['packaged_path'] for file in supplemental['files'] if file['path'].startswith('nerd-fonts/')]
            entry['issues'].append('Pinned glyph notices retained; missing glyph-set notices and exact glyph attribution remain unresolved')

    # These are the inputs selected by client/runtime build scripts, not an inferred link map.
    kit = Path(os.environ.get('GHOSTTY_KIT_DIR', root / '.ade/native/ghostty/macos/GhosttyKit.xcframework/macos-arm64'))
    for label, path in [('ghostty-renderer', kit / 'libghostty-internal.a'),
                        ('ghostty-parser', root / '.ade/native/vt/lib/libghostty-vt.a')]:
        entry = {'name': label, 'filename': path.name}
        if path.is_file():
            entry.update(sha256=file_digest(path), bytes=path.stat().st_size)
            command = subprocess.run(['ar', '-t', str(path)], capture_output=True, text=True)
            entry['members'] = [Path(line).name for line in command.stdout.splitlines()] if command.returncode == 0 else []
            if command.returncode:
                entry['issue'] = 'Archive members unavailable; ar could not inspect this format'
        else:
            entry['issue'] = 'Configured archive missing'
        result['static_archives'].append(entry)
    for name in ('ghostty', 'terminfo', 'assets', 'terminal.conf'):
        base = resources / name
        files = sorted(base.rglob('*')) if base.is_dir() else [base] if base.is_file() else []
        if not files:
            result['issues'].append('Packaged resource group missing or empty: ' + name)
        for path in files:
            if path.is_symlink() and (not path.exists() or not path.resolve().is_relative_to(resources.resolve())):
                raise RuntimeError('Resource path escapes packaged tree or is broken: ' + str(path.relative_to(resources)))
            if not path.is_file():
                continue
            if not path.resolve().is_relative_to(resources.resolve()):
                raise RuntimeError('Resource path escapes packaged tree: ' + str(path.relative_to(resources)))
            entry = {'path': str(path.relative_to(resources)), 'sha256': file_digest(path), 'bytes': path.stat().st_size}
            candidates = []
            relative = path.relative_to(resources)
            if name == 'ghostty':
                candidates.append(source / 'src' / path.relative_to(base))
            elif name == 'assets':
                candidates.append(root / 'assets' / path.relative_to(base))
            elif name == 'terminal.conf':
                candidates.append(root / 'assets/terminal.conf')
            for candidate in candidates:
                if candidate.is_file() and file_digest(candidate) == entry['sha256']:
                    entry['matching_source_path'] = str(candidate.relative_to(root))
            if path.stat().st_size < 256 * 1024:
                text = path.read_bytes().decode('utf-8', errors='replace')
                indicators = [line for line in text.splitlines()[:80] if re.search(
                    r'copyright|SPDX-License|licensed|license|GPL|permission', line, re.I)]
                if indicators:
                    entry['header_evidence'] = indicators
            if entry['path'] in ('ghostty/shell-integration/bash/ghostty.bash',
                                 'ghostty/shell-integration/zsh/ghostty-integration',
                                 'ghostty/shell-integration/zsh/.zshenv') and 'GPLv3' in '\n'.join(entry.get('header_evidence', [])):
                entry['license_evidence'] = 'Pinned source header declares GPL version 3 or later; review redistribution separately'
                entry['supplemental_notice_paths'] = [file['packaged_path'] for file in supplemental['files'] if file['path'] == 'GPL-3.0.txt']
            result['resources'].append(entry)
            if path.name.upper().startswith(PREFIXES):
                retain(destination, Path('licenses/resources') / path.relative_to(resources), path.read_bytes())
    assets = root / '.ade/vendor/gpui-kit/crates/assets'
    for path in sorted((assets / 'assets/icons').rglob('*.svg')):
        result['icon_source_files'].append({'path': str(path.relative_to(assets)), 'sha256': file_digest(path)})
    for name in ('LICENSE-LUCIDE', 'src/native_assets.rs', 'build.rs'):
        path = assets / name
        if path.is_file():
            retained = retain(destination, Path('native-manifests/gpui-assets') / name, path.read_bytes())
            if name == 'LICENSE-LUCIDE':
                result['icon_notice'] = retained
    result['issues'] += [
        'Ghostty shell integration GPL headers and canonical GPLv3 text are retained; full attribution/source obligation review remains open.',
        'Nerd Fonts is a composite: pinned glyph notices supplement its MIT text but do not establish complete attribution of all embedded glyph sets.',
        'GPUI AllAssets embeds the icon catalog in lux-ade; Lucide notice retained, per-icon exceptions require review.',
        'No link map or per-component binary attribution: static dependencies and exact embedded font subsets remain unverified.',
        'lux-ade-authored assets have no selected project license. Rust/provider inventories have separate scopes.']
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'native-resource-inventory.json').write_text(json.dumps(result, indent=2) + '\n')
    lines = ['# Native and resource evidence', '', result['scope'], '', result['cache_verification'], '',
             '## Unresolved review', ''] + ['- ' + issue for issue in result['issues']]
    lines += ['', '## Cached source evidence', '', '| Dependency | Retained notices | Issues |', '| --- | --- | --- |']
    for entry in result['cached_sources']:
        lines.append('| ' + entry['name'] + ' | ' + str(len(entry['notices'])) + ' | ' +
                     '; '.join(entry['issues'] or ['Texts retained, unreviewed']).replace('|', '\\|') + ' |')
    (destination / 'NATIVE_RESOURCE_NOTICES.md').write_text('\n'.join(lines) + '\n')
    return result
