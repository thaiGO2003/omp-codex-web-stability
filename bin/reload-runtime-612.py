#!/usr/bin/env python3
"""Reload the launcher-owned 6.1.12 native daemon only when every turn is idle.

The launcher retains ownership of the browser profile and starts a new daemon.
Use --if-idle for unattended attempts: busy or already-updated daemons are skipped.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


VERSION = '6.1.12'


def verify_files(runtime: Path) -> None:
    manifest = json.loads((runtime / 'manifest.json').read_text())
    if manifest.get('appVersion') != VERSION or manifest.get('entrypoint') != 'app/cli.js':
        raise ValueError('Unexpected native runtime manifest')
    for name in ('cli.js', 'browser-helper.cjs'):
        path = runtime / 'app' / name
        data = path.read_bytes()
        records = [r for r in manifest['files'] if r.get('path') == 'app/' + name]
        if (len(records) != 1 or len(data) != records[0]['size']
                or hashlib.sha256(data).hexdigest() != records[0]['sha256']):
            raise ValueError(f'Native manifest checksum mismatch: {name}')
        if name == 'cli.js' and (b'scoped_interrupt_settled:!0' not in data
                                 or b'__ompScopedInterruptSettlements' not in data):
            raise ValueError('Native 6.1.12 settled-interrupt patch missing')


def is_idle(health: dict) -> bool:
    return health.get('active_http_turns') == 0 and health.get('active_browser_turns') == 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--if-idle', action='store_true', help='Skip safely when a turn is active or patch is already loaded')
    parser.add_argument('--check-only', action='store_true', help='Verify eligibility without modifying the daemon')
    parser.add_argument('--stop-timer-on-success', action='store_true', help='Disable the optional retry timer after activation')
    args = parser.parse_args()

    def finish_timer():
        if args.stop_timer_on_success and not args.check_only:
            subprocess.run(['systemctl', '--user', 'disable', '--now', 'omp-native-612-safe-reload.timer'], check=True)

    root = Path(os.environ.get('CODEX_CHATGPT_WEB_HOME', str(Path.home() / '.codex-chatgpt-web')))
    config = json.loads((root / 'config.json').read_text())
    host = config.get('host', '127.0.0.1')
    if host not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('Reload only supports local native daemons')
    origin = f'http://[{host}]:{config["port"]}' if ':' in host else f'http://{host}:{config["port"]}'

    def request(path):
        admin = path.startswith('/admin/')
        req = urllib.request.Request(origin + path, data=b'{}' if admin else None,
                                     headers={'Authorization': 'Bearer ' + config['controlToken'],
                                              'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)

    health = request('/healthz')
    if health.get('version') != VERSION:
        raise ValueError('Native daemon is not 6.1.12')
    if health.get('scoped_interrupt_settled') is True:
        print('Already running patched 6.1.12 native daemon')
        finish_timer()
        return
    if not is_idle(health):
        message = (f'Native daemon is busy: HTTP turns={health.get("active_http_turns")}, '
                   f'browser turns={health.get("active_browser_turns")}; reload skipped')
        if args.if_idle:
            print(message)
            return
        raise ValueError(message)
    supervisor_path = root / 'runtime/launcher-supervisor.json'
    supervisor = json.loads(supervisor_path.read_text())
    pid = health.get('pid')
    owner = supervisor.get('ownerPid')
    if (not isinstance(pid, int) or not isinstance(owner, int)
            or supervisor.get('status') != 'ready' or supervisor.get('daemonPid') != pid
            or health.get('accepting_turns') is not True):
        raise ValueError('Launcher ownership or daemon readiness could not be verified')
    if not (Path('/proc') / str(owner)).exists():
        raise ValueError('Launcher owner process is not running')
    runtime = root / 'versions/6.1.12-linux-x64'
    expected_bundle = runtime / 'app/cli.js'
    args_for_pid = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
    if os.fsencode(str(expected_bundle)) not in args_for_pid:
        raise ValueError('Running daemon does not own the expected native bundle')
    verify_files(runtime)
    if args.check_only:
        print('Verified patched 6.1.12 bundle, manifest, launcher and idle daemon; eligible for reload')
        return

    drained = request('/admin/drain')
    if drained.get('accepting_turns') is not False or not is_idle(drained):
        request('/admin/resume')
        raise ValueError('Daemon became busy during drain; restored acceptance, skipped reload')
    try:
        if request('/admin/shutdown').get('status') != 'ok':
            raise ValueError('Daemon refused controlled shutdown')
    except BaseException:
        try:
            request('/admin/resume')
        except Exception:
            pass
        raise

    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            current = request('/healthz')
            state = json.loads(supervisor_path.read_text())
            if (current.get('pid') != pid and current.get('version') == VERSION
                    and current.get('scoped_interrupt_settled') is True
                    and current.get('accepting_turns') is True
                    and state.get('status') == 'ready'
                    and state.get('daemonPid') == current.get('pid')
                    and state.get('ownerPid') == owner):
                print('Patched 6.1.12 native daemon ready:', current['pid'])
                finish_timer()
                return
        except Exception:
            pass
        time.sleep(.5)
    raise TimeoutError('Launcher did not restore patched 6.1.12 within 45 seconds; inspect supervisor')


if __name__ == '__main__':
    main()
