"""Optional development tools must not change ordinary provisioning."""
import unittest
from install_tools import select_tools, extract_executable
from pathlib import Path
import tempfile
import zipfile
import stat


class ToolSelectionTests(unittest.TestCase):
    def setUp(self):
        self.tools = {'existing': {'version': '1'}, 'hyperfine': {'version': '2', 'optional': True}}

    def test_default_preserves_required_tools_only(self):
        self.assertEqual(select_tools(self.tools, []), ['existing'])

    def test_explicit_optional_selection_and_duplicate(self):
        self.assertEqual(select_tools(self.tools, ['hyperfine', 'hyperfine']), ['hyperfine'])

    def test_unknown_tool_fails(self):
        with self.assertRaises(ValueError):
            select_tools(self.tools, ['missing'])


class ToolArchiveTests(unittest.TestCase):
    def test_zip_selects_only_the_declared_platform_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'tools.zip'
            output = root / 'output'
            output.mkdir()
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('darwin/bacon', b'correct platform')
                bundle.writestr('linux/bacon', b'other platform')
                bundle.writestr('../unrelated', b'not extracted')
            binary = extract_executable(archive, output, 'bacon', {'member': 'darwin/bacon'})
            self.assertEqual(binary.read_bytes(), b'correct platform')
            self.assertEqual(list(output.iterdir()), [binary])
            self.assertFalse((root / 'unrelated').exists())

    def test_zip_rejects_absent_directory_link_and_parent_members(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'tools.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('directory/', b'')
                link = zipfile.ZipInfo('link')
                link.create_system = 3
                link.external_attr = (stat.S_IFLNK | 0o777) << 16
                bundle.writestr(link, b'/elsewhere')
            for member in ['missing', 'directory/', 'link', '../outside']:
                with self.subTest(member=member), self.assertRaises((KeyError, ValueError)):
                    extract_executable(archive, root, 'bacon', {'member': member})
