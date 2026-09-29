"""Normalize runner JSON/JUnit using standard-library parsers; never infer a missing pass."""
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def read_report(filename):
    path = Path(filename)
    if path.suffix == '.xml':
        root = ET.parse(path).getroot()
        cases = []
        for case in root.iter('testcase'):
            failed = any(case.find(tag) is not None for tag in ('failure', 'error', 'flakyFailure', 'flakyError', 'rerunFailure', 'rerunError'))
            skipped = case.find('skipped')
            # Node emits a passing file record when a name filter selects no tests in it.
            file_only = case.get('classname') == 'test' and case.get('file') is not None and case.get('name') == Path(case.get('file')).name
            cases.append({'id': case.get('classname', '') + ':' + case.get('name', ''),
                          'status': 'failed' if failed else 'skipped' if skipped is not None or file_only else 'passed',
                          'durationMs': float(case.get('time', '0')) * 1000 if case.get('time') is not None else None,
                          'skipReason': (skipped.get('message') or skipped.text or 'No reason provided') if skipped is not None else 'No matching test cases in file' if file_only else None})
        # A suite-level failure can exist without a testcase record (for example setup failure).
        errors = [element.text or 'Runner error' for element in root.findall('./error')]
        if any(int(suite.get('errors', '0')) + int(suite.get('failures', '0')) > 0 for suite in root.iter() if suite.tag in ('testsuite', 'testsuites')) and not any(case['status'] == 'failed' for case in cases):
            errors.append('Runner reports a suite failure without a failing testcase')
    else:
        data = json.loads(path.read_text())
        if 'testResults' in data:  # Vitest native JSON
            cases = [{'id': group['name'] + ':' + case['fullName'],
                      'status': 'skipped' if case['status'] in ('pending', 'todo', 'skipped') else case['status'],
                      'durationMs': case.get('duration'), 'skipReason': case.get('status') if case['status'] in ('pending', 'todo', 'skipped') else None}
                     for group in data['testResults'] for case in group.get('assertionResults', [])]
            errors = [] if data.get('success') is True else ['Runner did not report success']
        else:  # unittest lifecycle report
            cases = data['tests']
            errors = data.get('errors', [])
    seen = set()
    for case in cases:
        if case['id'] in seen:
            errors.append('Duplicate test record: ' + case['id'])
        seen.add(case['id'])
        if case['status'] not in ('passed', 'failed', 'skipped'):
            errors.append('Unexecuted or unknown test status: ' + case['status'])
    if not cases:
        errors.append('No test records')
    counts = {status: sum(case['status'] == status for case in cases) for status in ('passed', 'failed', 'skipped')}
    if not counts['passed']:
        errors.append('No passed test records')
    return {'status': 'failed' if errors or counts['failed'] else 'passed', 'counts': counts,
            'tests': cases, 'errors': errors, 'nativeReport': str(path),
            'summedTestMs': sum(case['durationMs'] for case in cases) if all(case['durationMs'] is not None for case in cases) else None}


if __name__ == '__main__':
    try:
        result = read_report(sys.argv[1])
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        result = {'status': 'failed', 'errors': [str(error)], 'tests': [], 'counts': None}
    print(json.dumps(result))
    raise SystemExit(0 if result['status'] == 'passed' else 1)
