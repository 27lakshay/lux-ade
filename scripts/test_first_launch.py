"""Installed startup must not treat bundle resources as an editable workspace."""
import unittest
from pathlib import Path
import runtime


class WorkspaceEnvironmentTests(unittest.TestCase):
    def test_installed_fresh_launch_waits_for_folder(self):
        env = runtime.workspace_environment({}, Path('/Applications/lux-ade.app/Contents/Resources'))
        self.assertNotIn('ADE_ROOT', env)
        self.assertEqual(env['ADE_WORKSPACE_SELECTION'], '1')

    def test_explicit_root_preserved_in_installed_app(self):
        env = runtime.workspace_environment({'ADE_ROOT': '/tmp/fixture'}, Path('/Applications/lux-ade.app/Contents/Resources'))
        self.assertEqual(env['ADE_ROOT'], '/tmp/fixture')
        self.assertNotIn('ADE_WORKSPACE_SELECTION', env)

    def test_development_default_preserved(self):
        env = runtime.workspace_environment({}, Path('/work/lux-ade'))
        self.assertEqual(env['ADE_ROOT'], '/work/lux-ade')

    def test_environment_not_mutated(self):
        source = {'PATH': '/bin'}
        runtime.workspace_environment(source, Path('/Applications/lux-ade.app/Contents/Resources'))
        self.assertEqual(source, {'PATH': '/bin'})
