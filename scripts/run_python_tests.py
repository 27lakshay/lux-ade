"""Run the selected unittest entry point with normal output and lifecycle JSON."""
import json
from pathlib import Path
import sys
import time
import unittest


class RecordingResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.records = []
        self.current = None

    def startTest(self, test):
        super().startTest(test)
        self.started = time.monotonic()
        self.current = {'id': test.id(), 'status': 'passed', 'durationMs': None, 'skipReason': None}

    def stopTest(self, test):
        self.current['durationMs'] = (time.monotonic() - self.started) * 1000
        self.records.append(self.current)
        super().stopTest(test)
        self.current = None

    def addFailure(self, test, err):
        self.current['status'] = 'failed'
        super().addFailure(test, err)

    def addError(self, test, err):
        if self.current is not None:
            self.current['status'] = 'failed'
        super().addError(test, err)

    def addUnexpectedSuccess(self, test):
        self.current['status'] = 'failed'
        super().addUnexpectedSuccess(test)

    def addSubTest(self, test, subtest, err):
        if err is not None:
            self.current['status'] = 'failed'
        super().addSubTest(test, subtest, err)

    def addExpectedFailure(self, test, err):
        self.current['expectedFailure'] = True
        super().addExpectedFailure(test, err)

    def addSkip(self, test, reason):
        if self.current is None:
            self.records.append({'id': test.id(), 'status': 'skipped', 'durationMs': None, 'skipReason': reason})
        else:
            self.current.update(status='skipped', skipReason=reason)
        super().addSkip(test, reason)


def main():
    pattern, output = sys.argv[1:]
    suite = unittest.defaultTestLoader.discover('scripts', pattern=pattern)
    result = unittest.TextTestRunner(resultclass=RecordingResult).run(suite)
    errors = [str(test) + ': ' + detail for test, detail in result.errors + result.failures]
    if not result.testsRun:
        errors.append('No tests discovered')
    Path(output).write_text(json.dumps({'tests': result.records, 'errors': errors, 'testsRun': result.testsRun}))
    return 0 if result.wasSuccessful() and result.testsRun else 1


if __name__ == '__main__':
    raise SystemExit(main())
