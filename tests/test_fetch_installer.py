"""Installer safety checks; optionally exercise real 6.1.7 bundles supplied locally."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
VENDOR = os.environ.get('CODEX_WEB_617_RUNTIME')


def manifest(runtime):
    records = []
    for path in sorted(runtime.rglob('*')):
        if path.is_file() and path.name != 'manifest.json':
            data = path.read_bytes()
            records.append({'path': path.relative_to(runtime).as_posix(), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    digest = hashlib.sha256()
    for record in records:
        for value in (record['path'], str(record['size']), record['sha256']):
            digest.update(value.encode() + b'\0')
    return {'appVersion': '6.1.7', 'platform': 'linux', 'arch': 'x64', 'files': records, 'bundleId': digest.hexdigest()}


class FetchInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / 'runtime'
        (self.runtime / 'app').mkdir(parents=True)
        for name in ('cli.js', 'browser-helper.cjs'):
            (self.runtime / 'app' / name).write_text('unknown layout')
        (self.runtime / 'unchanged.txt').write_text('preserve this file')
        self.save_manifest()

    def save_manifest(self):
        (self.runtime / 'manifest.json').write_text(json.dumps(manifest(self.runtime)))

    def snapshot(self):
        return {p.relative_to(self.runtime).as_posix(): p.read_bytes() for p in self.runtime.rglob('*') if p.is_file()}

    def run_patch(self, script, *args):
        return subprocess.run(['python3', str(ROOT / 'bin' / script), str(self.runtime), *args], capture_output=True, text=True, timeout=30)

    def rejected_unchanged(self, script):
        before = self.snapshot()
        result = self.run_patch(script)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.runtime.parent / 'codex-web-stability-backups').exists())

    def test_wrong_version_or_platform_rejected_before_writes(self):
        path = self.runtime / 'manifest.json'
        for key, value in [('appVersion', '6.1.6'), ('platform', 'win32'), ('arch', 'arm64')]:
            for script in ('patch-fetch-failure.py', 'patch-fetch-retry.py'):
                data = manifest(self.runtime)
                data[key] = value
                path.write_text(json.dumps(data))
                self.rejected_unchanged(script)

    def test_corrupt_manifest_and_unknown_layout_leave_both_bundles_unchanged(self):
        (self.runtime / 'app/cli.js').write_text('corrupt after manifest creation')
        for script in ('patch-fetch-failure.py', 'patch-fetch-retry.py'):
            self.rejected_unchanged(script)
        self.save_manifest()
        self.rejected_unchanged('patch-fetch-failure.py')
        self.rejected_unchanged('patch-fetch-retry.py')

    @unittest.skipUnless(VENDOR, 'Set CODEX_WEB_617_RUNTIME to test against unmodified vendor bundles')
    def test_real_bundles_preview_integrity_backups_and_idempotence(self):
        for name in ('cli.js', 'browser-helper.cjs'):
            (self.runtime / 'app' / name).write_bytes((Path(VENDOR) / 'app' / name).read_bytes())
        self.save_manifest()
        self.rejected_unchanged('patch-fetch-retry.py')
        original = self.snapshot()
        for script in ('patch-fetch-failure.py', 'patch-fetch-retry.py'):
            before = self.snapshot()
            result = self.run_patch(script, '--dry-run')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.snapshot(), before)
            result = self.run_patch(script)
            self.assertEqual(result.returncode, 0, result.stderr)
            actual = json.loads((self.runtime / 'manifest.json').read_text())
            self.assertEqual(actual, manifest(self.runtime))
        backups = self.runtime.parent / 'codex-web-stability-backups'
        saved = list(backups.rglob('cli.js'))
        self.assertEqual(len(saved), 2)
        self.assertTrue(any(p.read_bytes() == original['app/cli.js'] for p in saved))
        before = self.snapshot()
        for script in ('patch-fetch-failure.py', 'patch-fetch-retry.py'):
            result = self.run_patch(script)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(list(backups.rglob('cli.js'))), 2)
        self.assertEqual((self.runtime / 'unchanged.txt').read_bytes(), original['unchanged.txt'])
        bun = os.environ.get('BUN_EXE', 'bun')
        for script in ('verify-fetch-failure.ts', 'verify-fetch-retry.ts'):
            result = subprocess.run([bun, str(ROOT / 'tests' / script), str(self.runtime)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(VENDOR, 'Set CODEX_WEB_617_RUNTIME to test against unmodified vendor bundles')
    def test_invalid_second_bundle_cannot_partially_patch_first(self):
        (self.runtime / 'app/cli.js').write_bytes((Path(VENDOR) / 'app/cli.js').read_bytes())
        self.save_manifest()
        self.rejected_unchanged('patch-fetch-failure.py')
