"""Scratch ADE state for opt-in checks using the person's native provider authentication."""
import os
from pathlib import Path
import secrets


def profile_environment(root, source=None):
    source = os.environ if source is None else source
    # Keep native provider credential discovery (HOME/CODEX_HOME/etc.), but never
    # inherit an ADE profile, runtime, mock adapter or secret-store destination.
    environment = {key: value for key, value in source.items() if not key.startswith('ADE_')}
    for name in ('ADE_CODEX_BIN', 'ADE_CLAUDE_BIN', 'ADE_BUN_BIN'):
        if name in source:
            environment[name] = source[name]
    root = Path(root)
    workspace = root / 'workspace'
    workspace.mkdir(mode=0o700, exist_ok=True)
    secret_directory = root / 'secrets'
    secret_directory.mkdir(mode=0o700, exist_ok=True)
    environment.update({
        'ADE_SOCKET': str(root / 'daemon.sock'),
        'ADE_RUNTIME_SOCKET': str(root / 'runtime.sock'),
        'ADE_DATA_DIR': str(root / 'data'),
        'ADE_PROFILES_HOME': str(root / 'profiles'),
        'ADE_ROOT': str(workspace),
        'ADE_SECRET_STORE': 'file',
        'ADE_SECRET_FILE': str(secret_directory / 'store.json'),
        'ADE_SECRET_KEY': secrets.token_hex(32),
        'ADE_CODEX_TRANSPORT': 'stdio',
        'SHELL': '/bin/sh',
    })
    return environment


def missing_prerequisites(providers, opted_in, source=None, project=None, target=None):
    import shutil
    from paths import PROJECT_ROOT, TARGET_DIR
    source = os.environ if source is None else source
    project = PROJECT_ROOT if project is None else Path(project)
    target = TARGET_DIR if target is None else Path(target)
    missing = []
    if not opted_in:
        missing.append('explicit live-provider opt-in (can incur provider usage)')
    for binary in ('ade-daemon', 'ade-runtime'):
        candidate = target / 'debug' / binary
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            missing.append(f'debug {binary}; run pnpm build:backend')
    commands = []
    if 'codex' in providers:
        commands.append(('Codex CLI', source.get('ADE_CODEX_BIN', 'codex')))
    if 'claude' in providers:
        commands.extend([('Claude CLI', source.get('ADE_CLAUDE_BIN', 'claude')), ('Node.js', 'node')])
    if 'omp' in providers:
        commands.extend([('Bun', source.get('ADE_BUN_BIN', 'bun')),
                         ('OMP CLI', str(project / 'providers/omp/node_modules/.bin/omp'))])
    for label, command in commands:
        if not shutil.which(command, path=source.get('PATH', '')):
            missing.append(label)
    for provider, dependency in [('claude', '@anthropic-ai/claude-agent-sdk'), ('omp', '@oh-my-pi/pi-coding-agent')]:
        if provider in providers and not (project / 'providers' / provider / 'node_modules' / dependency / 'package.json').is_file():
            missing.append(f'{provider} workspace dependencies; run pnpm install')
    return missing
