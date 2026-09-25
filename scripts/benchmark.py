#!/usr/bin/env python3
"""Release benchmark of real GPUI/Ghostty/WKWebView windows and a separate daemon.

WebKit XPC helpers are launch-delta attributed (PPID is launchd); unrelated new
WebKit processes during the run can contaminate that group. GPU allocation and
input-to-photon latency are not measured. CPU 100% means one full logical core.
"""
from paths import PROJECT_ROOT, TARGET_DIR
import argparse
import json
import os
from pathlib import Path
from runtime_test_support import track_endpoint,cleanup_runtimes
import shlex
import signal
import socket
import subprocess
import tempfile
import time

ROOT = PROJECT_ROOT
BINS = TARGET_DIR / 'release'
FIXTURE = Path(__file__).with_name('benchmark_fixture.py')


def processes():
    result = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,time=,rss=,comm='], text=True).splitlines():
        fields = line.split(None, 4)
        if len(fields) != 5:
            continue
        pid, parent, cpu, rss, command = fields
        seconds = 0
        for part in cpu.split(':'):
            seconds = seconds * 60 + float(part)
        result[int(pid)] = {'parent': int(parent), 'cpu': seconds, 'rss': int(rss) / 1024, 'command': command}
    return result


def request(endpoint, value):
    with socket.socket(socket.AF_UNIX) as stream:
        stream.settimeout(40)
        stream.connect(endpoint)
        stream.sendall((json.dumps(value) + '\n').encode())
        if value['op'] == 'input':
            stream.sendall(b'{"op":"ping"}\n')
        return json.loads(stream.makefile('rb').readline())


def load(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}


def wait_for(check, seconds=60):
    end = time.monotonic() + seconds
    while not check():
        if time.monotonic() > end:
            raise RuntimeError('benchmark readiness timeout')
        time.sleep(.1)


def stop(process):
    if process and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)


def run_case(windows, output_dir, seconds, gpu_timing=True):
    with tempfile.TemporaryDirectory(prefix='ade-bench-') as directory:
        endpoint = str(Path(directory) / 'daemon.sock')
        base_env = dict(os.environ, ADE_SOCKET=endpoint, ADE_DATA_DIR=str(Path(directory) / 'data'),
                        ADE_ROOT=directory, SHELL='/bin/sh', ENV='/dev/null')
        daemon_log = (output_dir / f'{windows}-daemon.log').open('w')
        daemon = subprocess.Popen([str(BINS / 'ade-daemon')], env=base_env, stdout=daemon_log,
                                  stderr=daemon_log, start_new_session=True)
        client = None
        try:
            wait_for(lambda: Path(endpoint).exists(), 5)
            track_endpoint(endpoint)
            helper_baseline = {pid for pid, p in processes().items() if 'com.apple.WebKit.' in p['command']}
            telemetry = output_dir / f'{windows}-client.json'
            gpu = output_dir / f'{windows}-gpu.json'
            control = output_dir / f'{windows}-control'
            control.write_text('idle')
            client_log = (output_dir / f'{windows}-client.log').open('w')

            def launch():
                for path in (telemetry, gpu):
                    path.unlink(missing_ok=True)
                client_env = dict(base_env, ADE_BENCH_LOG=str(telemetry),
                    ADE_BENCH_START_US=str(time.time_ns() // 1000), ADE_BENCH_CONTROL=str(control))
                if gpu_timing: client_env['ADE_GPU_BENCH_LOG'] = str(gpu)
                else: client_env.pop('ADE_GPU_BENCH_LOG', None)
                return subprocess.Popen([str(BINS / 'ade-client'), '--windows', str(windows)],
                    env=client_env,
                    stdout=client_log, stderr=client_log, start_new_session=True)

            client = launch()
            wait_for(lambda: load(telemetry).get('restore_us', {}).get('count', 0) >= windows)
            cold = load(telemetry)
            time.sleep(2)

            def group(pid, table):
                if pid == client.pid: return 'client'
                if pid == daemon.pid: return 'daemon'
                if 'com.apple.WebKit.' in table[pid]['command'] and pid not in helper_baseline: return 'webkit_launch_delta'
                current, visited = pid, set()
                while current in table and current not in visited:
                    visited.add(current)
                    parent = table[current]['parent']
                    if parent == client.pid: return 'attach_processes'
                    if parent == daemon.pid: return 'shell_workload'
                    current = parent
                return None

            def measure(phase, duration, ping=False):
                first = previous = processes()
                started = time.monotonic()
                cpu, peak, ids = {}, {}, {}
                ping_due = started
                while time.monotonic() - started < duration:
                    if ping and time.monotonic() >= ping_due:
                        request(endpoint, {'op': 'input', 'data': f'ADE_PING:{time.time_ns() // 1000};\n'})
                        ping_due = time.monotonic() + .2
                    time.sleep(.2)
                    current = processes()
                    rss = {}
                    for pid, p in current.items():
                        category = group(pid, current)
                        if not category: continue
                        ids.setdefault(category, set()).add(pid)
                        rss[category] = rss.get(category, 0) + p['rss']
                        before = previous.get(pid, first.get(pid, {'cpu': 0}))['cpu']
                        cpu[category] = cpu.get(category, 0) + max(0, p['cpu'] - before)
                    for category, value in rss.items(): peak[category] = max(peak.get(category, 0), value)
                    previous = current
                    assert client.poll() is None and daemon.poll() is None, 'benchmark process exited'
                elapsed = time.monotonic() - started
                result = {'phase': phase, 'seconds': round(elapsed, 2),
                    'processes': {category: {'cpu_percent_one_core': round(value / elapsed * 100, 2),
                        'peak_rss_mib': round(peak.get(category, 0), 1), 'pids': sorted(ids[category])}
                        for category, value in cpu.items()},
                    'client_metrics_cumulative': load(telemetry), 'gpu_metrics_cumulative': load(gpu)}
                print(json.dumps({'windows': windows, **result}), flush=True)
                return result

            phases = [measure('idle', seconds)]
            command = f'python3 {shlex.quote(str(FIXTURE))} stream {seconds + 3}\n'
            request(endpoint, {'op': 'input', 'data': command})
            time.sleep(.7)
            phases.append(measure('stream_and_input', seconds, True))
            time.sleep(3)
            control.write_text('resize')
            phases.append(measure('window_resize', max(5, seconds / 2)))
            control.write_text('idle')
            stop(client)
            wait_for(lambda: request(endpoint, {'op': 'ping'})['metrics']['clients'] == 0, 10)
            history_done = Path(directory) / 'history-done'
            request(endpoint, {'op': 'input', 'data': f'python3 {shlex.quote(str(FIXTURE))} history {shlex.quote(str(history_done))}\n'})
            wait_for(history_done.exists, 60)
            time.sleep(.5)
            before = request(endpoint, {'op': 'ping'})['metrics']
            client = launch()
            wait_for(lambda: load(telemetry).get('restore_us', {}).get('count', 0) >= windows, 120)
            recovered = load(telemetry)
            assert request(endpoint, {'op': 'ping'})['metrics']['shell_pid'] == before['shell_pid']
            phases.append(measure('large_history_reconnected', seconds))
            return {'windows': windows, 'cold_start': cold, 'large_history_reconnect': recovered, 'phases': phases}
        finally:
            stop(client)
            stop(daemon)
            cleanup_runtimes()
            daemon_log.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-gpu-timing', action='store_true')
    parser.add_argument('--seconds', type=float, default=10)
    parser.add_argument('--windows', type=int, nargs='+', default=[1, 4, 10])
    parser.add_argument('--output', type=Path, default=ROOT / 'work/benchmarks/ownership')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'method': __doc__, 'gpu_timing_enabled': not args.no_gpu_timing, 'results': []}
    for count in args.windows:
        report['results'].append(run_case(count, args.output, args.seconds, not args.no_gpu_timing))
        (args.output / 'results.json').write_text(json.dumps(report, indent=2))
        time.sleep(2)


if __name__ == '__main__':
    main()
