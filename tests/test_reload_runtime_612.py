"""Exercise 6.1.12's guarded reload without touching a real daemon."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reload612', ROOT / 'bin/reload-runtime-612.py')
reload612 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reload612)


class Reload612Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / 'versions/6.1.12-linux-x64'
        (self.runtime / 'app').mkdir(parents=True)
        (self.root / 'runtime').mkdir()
        entries = []
        for name in ('cli.js', 'browser-helper.cjs'):
            data = (b'__ompScopedInterruptSettlements scoped_interrupt_settled:!0'
                    if name == 'cli.js' else b'browser-helper fixture')
            (self.runtime / 'app' / name).write_bytes(data)
            entries.append({'path': 'app/' + name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        (self.runtime / 'manifest.json').write_text(json.dumps({
            'appVersion': '6.1.12', 'entrypoint': 'app/cli.js', 'files': entries,
        }))
        (self.root / 'config.json').write_text(json.dumps({
            'host': '127.0.0.1', 'port': 17841, 'controlToken': 'test-token',
        }))
        self.supervisor = self.root / 'runtime/launcher-supervisor.json'
        self.supervisor.write_text(json.dumps({'status': 'ready', 'daemonPid': 12345, 'ownerPid': 1234}))
        self.health = {'version': '6.1.12', 'pid': 12345, 'accepting_turns': True,
                       'active_http_turns': 0, 'active_browser_turns': 0}
        self.paths = []

    def run_reload(self, scenario='success', *args):
        def urlopen(req, timeout):
            path = req.full_url.removeprefix('http://127.0.0.1:17841')
            self.paths.append(path)
            if path == '/healthz':
                value = dict(self.health)
                if '/admin/shutdown' in self.paths:
                    value.update(pid=12346, scoped_interrupt_settled=True)
                    self.supervisor.write_text(json.dumps({'status': 'ready', 'daemonPid': 12346, 'ownerPid': 1234}))
            elif path == '/admin/drain':
                value = {**self.health, 'accepting_turns': False,
                         'active_browser_turns': 1 if scenario == 'drain_race' else 0}
            elif path == '/admin/shutdown':
                value = {'status': 'refused' if scenario == 'refused' else 'ok'}
            else:
                self.assertEqual(path, '/admin/resume')
                value = {'status': 'ok', 'accepting_turns': True}
            return io.BytesIO(json.dumps(value).encode())

        original_read = Path.read_bytes
        original_exists = Path.exists

        def read_bytes(path):
            if str(path) == '/proc/12345/cmdline':
                return os.fsencode(str(self.runtime / 'app/cli.js')) + b'\0serve\0'
            return original_read(path)

        def exists(path):
            if str(path) == '/proc/1234':
                return True
            return original_exists(path)

        with patch.dict(os.environ, {'CODEX_CHATGPT_WEB_HOME': str(self.root)}), \
             patch.object(reload612.urllib.request, 'urlopen', urlopen), \
             patch.object(Path, 'read_bytes', read_bytes), \
             patch.object(Path, 'exists', exists), \
             patch.object(sys, 'argv', ['reload-runtime-612.py', *args]):
            reload612.main()

    def test_idle_native_reloads_and_checks_patched_health(self):
        self.run_reload()
        self.assertEqual(self.paths, ['/healthz', '/admin/drain', '/admin/shutdown', '/healthz'])

    def test_busy_runtime_skips_without_modifying_daemon(self):
        self.health['active_browser_turns'] = 1
        self.run_reload('success', '--if-idle')
        self.assertEqual(self.paths, ['/healthz'])

    def test_already_patched_does_not_reload(self):
        self.health['scoped_interrupt_settled'] = True
        self.run_reload('success', '--if-idle')
        self.assertEqual(self.paths, ['/healthz'])

    def test_draining_race_and_refused_shutdown_resume(self):
        for scenario in ('drain_race', 'refused'):
            with self.subTest(scenario=scenario):
                self.paths.clear()
                with self.assertRaises(ValueError):
                    self.run_reload(scenario)
                self.assertEqual(self.paths[-1], '/admin/resume')

    def test_manifest_corruption_never_drains(self):
        (self.runtime / 'app/cli.js').write_text('corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.run_reload()
        self.assertEqual(self.paths, ['/healthz'])


if __name__ == '__main__':
    unittest.main()
