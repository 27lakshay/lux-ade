#!/usr/bin/env python3
"""Enforce the actual Cargo dependency graph, including transitive dependencies."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def verify(metadata):
    packages = {package['id']: package for package in metadata['packages']}
    nodes = {node['id']: node for node in metadata['resolve']['nodes']}
    members = {packages[key]['name']: key for key in metadata['workspace_members']}
    forbidden = {
        'ade-core': {'ade-daemon', 'ade-runtime', 'ade-platform', 'rusqlite', 'portable-pty'},
        'ade-runtime': {'ade-daemon', 'rusqlite'},
        'ade-daemon': set(),
    }
    failures = []
    for owner, banned in forbidden.items():
        visited = set()
        pending = [members[owner]]
        while pending:
            key = pending.pop()
            if key in visited:
                continue
            visited.add(key)
            for dependency in nodes[key]['deps']:
                # Development-only dependencies do not ship with the application.
                if not any(kind['kind'] != 'dev' for kind in dependency['dep_kinds']):
                    continue
                dep_id = dependency['pkg']
                name = packages[dep_id]['name']
                if name in banned or 'gpui' in name or name in {'wry', 'lb-wry'}:
                    failures.append(f'{owner} depends on forbidden implementation {name}')
                pending.append(dep_id)
    return sorted(set(failures))


if __name__ == '__main__':
    metadata = json.loads(subprocess.check_output(
        [os.environ.get('CARGO', 'cargo'), 'metadata', '--locked', '--offline', '--format-version', '1'],
        cwd=ROOT,
    ))
    failures = verify(metadata)
    if failures:
        raise SystemExit('\n'.join(failures))
    print('Architecture checks passed: core/runtime/daemon contain no UI dependencies.')
