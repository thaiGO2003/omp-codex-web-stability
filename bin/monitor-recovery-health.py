#!/usr/bin/env python3
"""Check installed OMP shim/native recovery health and report state changes.

Runs as an unprivileged, read-only systemd user timer. No auth is required and
only health metadata is retained; prompt content and credentials are excluded.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
import urllib.request


STATE_PATH = Path(os.environ.get(
    'OMP_RECOVERY_MONITOR_STATE',
    str(Path.home() / '.local/state/omp-codex-web-stability/health-watch.json'),
))


def read_health(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=4) as result:
        value = json.load(result)
    if not isinstance(value, dict):
        raise ValueError('invalid health response')
    return value


def check() -> list[str]:
    problems = []
    try:
        native = read_health('http://127.0.0.1:17841/healthz')
        if native.get('status') != 'ok' or native.get('accepting_turns') is not True:
            problems.append('native_unready')
        if (native.get('version') != '6.1.12'
                or native.get('scoped_interrupt_settled') is not True):
            problems.append('native_recovery_unverified')
    except (OSError, ValueError, TimeoutError):
        problems.append('native_unreachable')
    try:
        shim = read_health('http://127.0.0.1:3007/omp-shim-health')
        if (shim.get('service') != 'omp-codex-web-shim'
                or shim.get('upstreamOrigin') != 'http://127.0.0.1:17841'):
            problems.append('shim_unready')
        diagnostics = shim.get('diagnostics')
        if not isinstance(diagnostics, dict) or diagnostics.get('failedWrites') != 0:
            problems.append('shim_diagnostics_failed')
    except (OSError, ValueError, TimeoutError):
        problems.append('shim_unreachable')
    return problems


def notify(message: str) -> None:
    print(message, flush=True)
    if shutil.which('notify-send'):
        try:
            subprocess.run(['notify-send', 'OMP / Codex Web monitor', message],
                           timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass


def run() -> None:
    try:
        previous = json.loads(STATE_PATH.read_text())
        if not isinstance(previous, dict):
            previous = {}
    except (OSError, ValueError):
        previous = {}

    problems = check()
    previous_failures = previous.get('failures', 0)
    if not isinstance(previous_failures, int) or isinstance(previous_failures, bool) or previous_failures < 0:
        previous_failures = 0
    failures = previous_failures + 1 if problems else 0
    last_state = previous.get('state')
    state = 'degraded' if failures >= 2 else ('healthy' if not problems else 'pending')
    if state == 'degraded' and last_state != 'degraded':
        notify('Recovery services degraded: ' + ', '.join(sorted(problems)))
    elif state == 'healthy' and last_state == 'degraded':
        notify('Recovery services healthy again')

    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {'state': state, 'failures': failures, 'problems': sorted(problems),
              'checked_at': datetime.now(timezone.utc).isoformat()}
    with tempfile.NamedTemporaryFile(mode='w', dir=STATE_PATH.parent,
                                     prefix='.health-watch-', delete=False) as output:
        json.dump(record, output)
        output.write('\n')
        candidate = Path(output.name)
    try:
        os.chmod(candidate, 0o600)
        os.replace(candidate, STATE_PATH)
    finally:
        candidate.unlink(missing_ok=True)


if __name__ == '__main__':
    run()
