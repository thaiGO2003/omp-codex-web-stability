#!/usr/bin/env python3
"""Reload only the idle 6.1.9 daemon; reopening the launcher restores its bundle."""
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request


def main():
    root = Path(os.environ.get('CODEX_CHATGPT_WEB_HOME', str(Path.home() / '.codex-chatgpt-web')))
    config = json.loads((root / 'config.json').read_text())
    host = config.get('host', '127.0.0.1')
    if host not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('Reload requires a local daemon')
    origin = f'http://[{host}]:{config["port"]}' if ':' in host else f'http://{host}:{config["port"]}'

    def request(path):
        admin = path.startswith('/admin/')
        req = urllib.request.Request(origin + path, data=b'{}' if admin else None,
                                     headers={'Authorization': 'Bearer ' + config['controlToken'],
                                              'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)

    health = request('/healthz')
    supervisor_path = root / 'runtime/launcher-supervisor.json'
    supervisor = json.loads(supervisor_path.read_text())
    if (health.get('version') != '6.1.9' or health.get('active_http_turns') != 0
            or health.get('active_browser_turns') != 0 or not health.get('accepting_turns')
            or supervisor.get('status') != 'ready' or supervisor.get('daemonPid') != health.get('pid')):
        raise ValueError('6.1.9 launcher-owned runtime must be ready and idle; no restart performed')
    pid = health['pid']
    args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
    runtime = root / 'versions/6.1.9-linux-x64'
    if os.fsencode(str(runtime / 'app/cli.js')) not in args:
        raise ValueError('Daemon is not running the expected installed runtime')
    manifest = json.loads((runtime / 'manifest.json').read_text())
    for name in ('cli.js', 'browser-helper.cjs'):
        data = (runtime / 'app' / name).read_bytes()
        records = [r for r in manifest['files'] if r['path'] == 'app/' + name]
        if (len(records) != 1 or len(data) != records[0]['size']
                or hashlib.sha256(data).hexdigest() != records[0]['sha256']
                or b'submittedAppMentionHref=await' not in data):
            raise ValueError(f'{name}: apply the verified rebinding patch before reload')
    drained = request('/admin/drain')
    if (drained.get('accepting_turns') is not False or drained.get('active_http_turns') != 0
            or drained.get('active_browser_turns') != 0):
        request('/admin/resume')
        raise ValueError('Runtime became busy; drain reversed and reload skipped')
    try:
        if request('/admin/shutdown').get('status') != 'ok':
            raise ValueError('Daemon refused shutdown')
    except BaseException:
        # If shutdown failed, keep the existing daemon accepting turns.
        try:
            request('/admin/resume')
        except Exception:
            pass
        raise
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            current = request('/healthz')
            state = json.loads(supervisor_path.read_text())
            if (current.get('pid') != pid and current.get('version') == '6.1.9'
                    and current.get('accepting_turns') is True
                    and state.get('status') == 'ready' and state.get('daemonPid') == current.get('pid')
                    and state.get('ownerPid') == supervisor.get('ownerPid')):
                print('Patched daemon ready:', current['pid'], '(launcher and browser profile preserved)')
                return
        except Exception:
            pass
        time.sleep(.5)
    raise TimeoutError('Launcher did not restore a ready daemon within 30 seconds; inspect supervisor status')


if __name__ == '__main__':
    main()
