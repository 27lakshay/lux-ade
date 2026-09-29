"""Failure-focused regression checks for native runner evidence."""
import json
from pathlib import Path
import tempfile
import unittest
from native_report import read_report


class NativeReportTests(unittest.TestCase):
    def parse(self, body, extension):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ('report.' + extension)
            path.write_text(body)
            return read_report(path)

    def test_junit_failure_and_skip(self):
        report = self.parse('<testsuite><testcase name="a" time="0.1"/><testcase name="b"><failure/></testcase><testcase name="c"><skipped message="helper"/></testcase></testsuite>', 'xml')
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['counts'], {'passed': 1, 'failed': 1, 'skipped': 1})
        self.assertEqual(report['tests'][0]['durationMs'], 100)
        self.assertEqual(report['tests'][2]['skipReason'], 'helper')

    def test_duplicate_and_empty_fail(self):
        self.assertEqual(self.parse('<testsuite/>', 'xml')['status'], 'failed')
        self.assertEqual(self.parse('<testsuite><testcase name="a"/><testcase name="a"/></testsuite>', 'xml')['status'], 'failed')

    def test_all_skipped_reports_cannot_pass(self):
        reports = [
            ('xml', '<testsuite><testcase name="a"><skipped message="filter"/></testcase></testsuite>'),
            ('json', json.dumps({'success': True, 'testResults': [{'name': 'a', 'assertionResults': [{'fullName': 'b', 'status': 'pending'}]}]})),
            ('json', json.dumps({'tests': [{'id': 'a', 'status': 'skipped', 'durationMs': 0, 'skipReason': 'filter'}]})),
        ]
        for extension, body in reports:
            with self.subTest(body=body):
                report = self.parse(body, extension)
                self.assertEqual(report['status'], 'failed')
                self.assertEqual(report['counts'], {'passed': 0, 'failed': 0, 'skipped': 1})
                self.assertIn('No passed test records', report['errors'])

    def test_mixed_pass_and_skip_remains_successful(self):
        report = self.parse('<testsuite><testcase name="a"/><testcase name="b"><skipped message="helper"/></testcase></testsuite>', 'xml')
        self.assertEqual(report['status'], 'passed')
        self.assertEqual(report['counts'], {'passed': 1, 'failed': 0, 'skipped': 1})
        self.assertEqual(report['tests'][1]['skipReason'], 'helper')

    def test_node_file_records_without_matching_tests_fail(self):
        report = self.parse('<testsuites><testcase name="bridge.test.mjs" classname="test" file="/providers/claude/bridge.test.mjs"/></testsuites>', 'xml')
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['counts'], {'passed': 0, 'failed': 0, 'skipped': 1})
        self.assertIn('No passed test records', report['errors'])

    def test_matching_node_case_passes_with_unmatched_files(self):
        report = self.parse('<testsuites><testcase name="bridge.test.mjs" classname="test" file="/providers/claude/bridge.test.mjs"/><testcase name="actual test" classname="test" file="/providers/claude/tasks.test.mjs"/></testsuites>', 'xml')
        self.assertEqual(report['status'], 'passed')
        self.assertEqual(report['counts'], {'passed': 1, 'failed': 0, 'skipped': 1})

    def test_vitest_failure_even_when_assertions_pass(self):
        data = {'success': False, 'testResults': [{'name': 'a', 'assertionResults': [{'fullName': 'b', 'status': 'passed', 'duration': 1}]}]}
        self.assertEqual(self.parse(json.dumps(data), 'json')['status'], 'failed')

    def test_missing_report_is_an_error(self):
        with self.assertRaises(FileNotFoundError):
            read_report('/nonexistent/ade-native-report.xml')

    def test_suite_errors_and_retries_do_not_become_passes(self):
        self.assertEqual(self.parse('<testsuite errors="1"><testcase name="a"/></testsuite>', 'xml')['status'], 'failed')
        self.assertEqual(self.parse('<testsuite><testcase name="a"><flakyFailure/></testcase></testsuite>', 'xml')['status'], 'failed')
