#!/usr/bin/env python3
"""Recovery controller integration: disposable real daemon, supervisor and PTY."""
from paths import PROJECT_ROOT, TARGET_DIR
import json, os, subprocess, tempfile, time
from pathlib import Path
import runtime
from runtime_test_support import track_runtime, cleanup_runtimes

DAEMON = TARGET_DIR / 'release/ade-daemon'
with tempfile.TemporaryDirectory(prefix='ade-recovery-', dir='/tmp') as tmp:
    root = Path(tmp); home = root/'home'; data = root/'data'; endpoint = root/'app.sock'
    home.mkdir(); data.mkdir(); runtime.save_binding(home, data)
    env = {**os.environ, 'ADE_DATA_DIR': str(data), 'ADE_RUNTIME_HOME': str(home),
           'ADE_SOCKET': str(endpoint), 'ADE_ROOT': str(root), 'SHELL': '/bin/sh'}
    def cli(action, *extra, success=True, override=None):
        result = subprocess.run(['python3', str(Path(__file__).with_name('runtime.py')), action,
                                 '--home', str(home), '--daemon', str(DAEMON), *extra],
                                env=override or env, capture_output=True, text=True, timeout=30)
        if not success:
            assert result.returncode != 0, result.stdout
            return result.stderr
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    def rpc(op, **fields): return runtime.rpc(endpoint, {'op':op, **fields})
    def shell(): return rpc('runtime.status')['terminals'][0]['metrics']['shell_pid']
    try:
        assert cli('status')['daemon'] is None
        first = cli('start')['daemon']; track_runtime(first)
        original_shell = shell()
        check = cli('status')
        assert check['daemon_update'] is False and check['supervisor_update'] is False, check
        assert cli('start')['daemon']['boot_id'] == first['boot_id']
        assert '--stop-active' in cli('replace-supervisor', success=False)
        assert shell() == original_shell
        restarted = cli('restart')['daemon']; track_runtime(restarted)
        assert restarted['boot_id'] != first['boot_id']
        assert restarted['runtime_instance'] == first['runtime_instance']
        assert shell() == original_shell
        wrong = {**env, 'ADE_DATA_DIR': str(root/'wrong')}
        assert 'different data directory' in cli('restart', success=False, override=wrong)
        assert rpc('hello')['boot_id'] == restarted['boot_id']
        replaced = cli('replace-supervisor', '--stop-active')['daemon']; track_runtime(replaced)
        assert replaced['runtime_instance'] != first['runtime_instance']
        assert shell() != original_shell
        # A missing daemon can be restarted while retaining its supervisor.
        rpc('runtime.prepare_restart', boot_id=replaced['boot_id'])
        runtime.wait_unlocked(data, 'writer.lock')
        assert cli('status')['daemon'] is None
        recovered = cli('start')['daemon']; track_runtime(recovered)
        assert recovered['runtime_instance'] == replaced['runtime_instance']
        # Update detection compares identities, never treats unknown as current.
        fake = dict(recovered, build_id='different')
        original_hello = runtime.hello
        runtime.hello = lambda sock: fake
        assert runtime.inspect(home,data,endpoint,DAEMON)['daemon_update'] is True
        fake['build_id'] = None
        assert runtime.inspect(home,data,endpoint,DAEMON)['daemon_update'] is None
        runtime.hello = original_hello
        print('RECOVERY_PASS: build identities, retry, daemon handoff, supervisor replacement, profile isolation')
    finally:
        try:
            running = rpc('hello')
            rpc('runtime.prepare_restart', boot_id=running['boot_id'])
            runtime.wait_unlocked(data, 'writer.lock')
        except (OSError, RuntimeError): pass
        cleanup_runtimes()
