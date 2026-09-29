"""Live opt-in checks keep ADE ownership separate from native provider authentication."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from live_profile import profile_environment, missing_prerequisites


class LiveProfileTests(unittest.TestCase):
    def test_inherited_profile_and_mock_state_cannot_escape_scratch_root(self):
        with tempfile.TemporaryDirectory() as directory:
            source = {'HOME': '/native-provider-home', 'CODEX_HOME': '/native-codex-home',
                      'ADE_SOCKET': '/real/socket', 'ADE_RUNTIME_SOCKET': '/real/runtime',
                      'ADE_PROFILES_HOME': '/real/profiles', 'ADE_SECRET_FILE': '/real/secrets',
                      'ADE_SECRET_KEY': 'inherited-secret', 'ADE_SECRET_STORE': 'keychain',
                      'ADE_MOCK_CODEX': '1', 'ADE_CLAUDE_BRIDGE_BIN': '/mock/bridge',
                      'ADE_CODEX_BIN': '/installed/codex'}
            env = profile_environment(directory, source)
            for name in ['ADE_SOCKET', 'ADE_RUNTIME_SOCKET', 'ADE_PROFILES_HOME', 'ADE_DATA_DIR', 'ADE_ROOT', 'ADE_SECRET_FILE']:
                self.assertTrue(Path(env[name]).is_relative_to(directory))
            self.assertEqual(env['ADE_SECRET_STORE'], 'file')
            self.assertRegex(env['ADE_SECRET_KEY'], r'^[0-9a-f]{64}$')
            self.assertNotEqual(env['ADE_SECRET_KEY'], source['ADE_SECRET_KEY'])
            self.assertEqual(env['HOME'], source['HOME'])
            self.assertEqual(env['CODEX_HOME'], source['CODEX_HOME'])
            self.assertEqual(env['ADE_CODEX_BIN'], '/installed/codex')
            self.assertNotIn('ADE_MOCK_CODEX', env)
            self.assertNotIn('ADE_CLAUDE_BRIDGE_BIN', env)
            self.assertEqual(source['ADE_SOCKET'], '/real/socket')

    def test_missing_prerequisites_do_not_launch_binaries(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = missing_prerequisites(['codex', 'claude', 'omp'], False,
                                            source={'PATH': ''}, project=directory, target=directory)
            self.assertIn('explicit live-provider opt-in (can incur provider usage)', missing)
            self.assertIn('Codex CLI', missing)
            self.assertIn('Claude CLI', missing)
            self.assertIn('Bun', missing)
            self.assertIn('OMP CLI', missing)
            self.assertIn('debug ade-daemon; run pnpm build:backend', missing)

    def test_public_command_reports_missing_opt_in_without_exposing_credentials(self):
        environment = dict(os.environ, ADE_RUN_LIVE_PROVIDERS='', OPENAI_API_KEY='fixture-secret-must-not-be-logged')
        for script, args, providers in [
            ('live_provider_check.py', ['codex'], ['codex']),
            ('test_agent_handoff_live.py', [], ['codex', 'claude']),
        ]:
            with self.subTest(script=script):
                result = subprocess.run([sys.executable, f'scripts/{script}', *args],
                                        env=environment, text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 1)
                report = json.loads(result.stdout)
                self.assertEqual(report['failureCategory'], 'prerequisite-unavailable')
                self.assertEqual(report['unexecutedProviders'], providers)
                self.assertEqual(report.get('results', []), [])
                expected = ['F021'] if script == 'live_provider_check.py' else ['R005']
                self.assertEqual(report['acceptanceScope']['requirementIds'], expected)
                self.assertEqual(report['acceptanceScope']['fullRequirementAcceptance'], 'unverified')
                self.assertNotIn(environment['OPENAI_API_KEY'], result.stdout + result.stderr)
                directory = re.search(r'Test report: (.+)', result.stderr)
                self.assertIsNotNone(directory)
                persisted = (Path(directory.group(1)) / 'summary.json').read_text()
                self.assertEqual(json.loads(persisted), report)
                self.assertNotIn(environment['OPENAI_API_KEY'], persisted)


if __name__ == '__main__':
    unittest.main()
