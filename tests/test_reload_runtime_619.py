import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reload619', ROOT / 'bin/reload-runtime-619.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Reload619Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / 'versions/6.1.9-linux-x64'
        (self.runtime / 'app').mkdir(parents=True)
        (self.root / 'runtime').mkdir()
        records = []
        for name in ['cli.js', 'browser-helper.cjs']:
            data = b'submittedAppMentionHref=await verifiedFixture()'
            (self.runtime / 'app' / name).write_bytes(data)
            records.append({'path': 'app/' + name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        (self.runtime / 'manifest.json').write_text(json.dumps({'files': records}))
        (self.root / 'config.json').write_text(json.dumps({'host': '127.0.0.1', 'port': 17841, 'controlToken': 'fixture-only'}))
        self.supervisor = self.root / 'runtime/launcher-supervisor.json'
        self.supervisor.write_text(json.dumps({'status': 'ready', 'daemonPid': 12345, 'ownerPid': 1234}))
        self.health = {'version': '6.1.9', 'pid': 12345, 'accepting_turns': True,
                       'active_http_turns': 0, 'active_browser_turns': 0}
        self.paths = []

    def run_reload(self, scenario):
        def urlopen(req, timeout):
            path = req.full_url.removeprefix('http://127.0.0.1:17841')
            self.paths.append(path)
            if path == '/healthz':
                data = dict(self.health)
                if '/admin/shutdown' in self.paths:
                    data['pid'] = 12346
                    self.supervisor.write_text(json.dumps({'status': 'ready', 'daemonPid': 12346, 'ownerPid': 1234}))
            elif path == '/admin/drain':
                data = {**self.health, 'accepting_turns': False,
                        'active_http_turns': 1 if scenario == 'drain_race' else 0}
            elif path == '/admin/shutdown':
                data = {'status': 'refused' if scenario == 'refused' else 'ok'}
            else:
                self.assertEqual(path, '/admin/resume')
                data = {'status': 'ok', 'accepting_turns': True}
            return io.BytesIO(json.dumps(data).encode())

        original = Path.read_bytes

        def read_bytes(p):
            if str(p) == '/proc/12345/cmdline':
                return os.fsencode(str(self.runtime / 'app/cli.js')) + b'\0serve\0'
            return original(p)

        with patch.dict(os.environ, {'CODEX_CHATGPT_WEB_HOME': str(self.root)}), \
                patch.object(module.urllib.request, 'urlopen', urlopen), \
                patch.object(Path, 'read_bytes', read_bytes):
            module.main()

    def test_idle_reload_preserves_launcher(self):
        self.run_reload('success')
        self.assertEqual(self.paths, ['/healthz', '/admin/drain', '/admin/shutdown', '/healthz'])

    def test_busy_runtime_never_drained(self):
        self.health['active_browser_turns'] = 1
        with self.assertRaisesRegex(ValueError, 'ready and idle'):
            self.run_reload('success')
        self.assertEqual(self.paths, ['/healthz'])

    def test_busy_drain_and_refused_shutdown_resume_original(self):
        for scenario in ['drain_race', 'refused']:
            with self.subTest(scenario=scenario):
                self.paths.clear()
                with self.assertRaises(ValueError):
                    self.run_reload(scenario)
                self.assertEqual(self.paths[-1], '/admin/resume')
                if scenario == 'drain_race':
                    self.assertNotIn('/admin/shutdown', self.paths)

    def test_corrupted_bundle_prevents_drain(self):
        (self.runtime / 'app/cli.js').write_text('corrupt')
        with self.assertRaisesRegex(ValueError, 'apply the verified'):
            self.run_reload('success')
        self.assertEqual(self.paths, ['/healthz'])
