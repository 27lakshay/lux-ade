#!/usr/bin/env python3
"""Real ten-viewer CPU regression. Run on an otherwise idle Mac, release build.

The two-core ceiling is a regression guard for the six-core failure, not a final
product budget. Use benchmark.py for full comparisons. No GPU timing is enabled.
"""
import argparse
import os
from pathlib import Path
from runtime_test_support import track_endpoint,cleanup_runtimes
import shlex
import subprocess
import tempfile
import time
import benchmark as b


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sample', type=Path)
    parser.add_argument('--max-cpu', type=float, default=200)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='ade-scaling-') as directory:
        endpoint = str(Path(directory) / 'daemon.sock')
        telemetry = Path(directory) / 'client.json'
        env = dict(os.environ, ADE_SOCKET=endpoint, ADE_DATA_DIR=str(Path(directory) / 'data'),
                   ADE_ROOT=directory, SHELL='/bin/sh', ENV='/dev/null', ADE_BENCH_LOG=str(telemetry))
        env.pop('ADE_GPU_BENCH_LOG', None)
        daemon = subprocess.Popen([str(b.BINS / 'ade-daemon')], env=env, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, start_new_session=True)
        client = None
        try:
            b.wait_for(lambda: Path(endpoint).exists(), 5)
            track_endpoint(endpoint)
            client = subprocess.Popen([str(b.BINS / 'ade-client'), '--windows', '10'], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            b.wait_for(lambda: b.load(telemetry).get('restore_us', {}).get('count', 0) >= 10)
            b.request(endpoint, {'op':'input', 'data':f'python3 {shlex.quote(str(b.FIXTURE))} stream 15\n'})
            time.sleep(2)
            output_before = b.request(endpoint, {'op':'ping'})['metrics']['terminal_bytes']
            before = b.processes()[client.pid]['cpu']
            start = time.monotonic()
            if args.sample:
                subprocess.run(['sample', str(client.pid), '3', '5', '-file', str(args.sample.resolve())],
                               check=True, stdout=subprocess.DEVNULL)
            else:
                time.sleep(5)
            cpu = (b.processes()[client.pid]['cpu'] - before) / (time.monotonic() - start) * 100
            output_after = b.request(endpoint, {'op':'ping'})['metrics']['terminal_bytes']
            assert output_after - output_before > 250_000, 'stream workload did not remain active'
            assert b.load(telemetry).get('feed_us', {}).get('count', 0) > 1000, 'viewers did not consume output'
            print(f'RENDER_SCALING: 10 viewers, client CPU {cpu:.2f}%, ceiling {args.max_cpu:.2f}%', flush=True)
            assert cpu < args.max_cpu, 'ten-viewer rendering exceeds CPU regression ceiling'
        finally:
            b.stop(client)
            b.stop(daemon)
            cleanup_runtimes()


if __name__ == '__main__':
    run()
