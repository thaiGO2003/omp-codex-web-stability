import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import test_fetch_installer as fixtures

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rebinding619', ROOT / 'bin/patch-browser-rebinding-619.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Rebinding619InstallerTests(unittest.TestCase):
    setUp = fixtures.FetchInstallerTests.setUp
    snapshot = fixtures.FetchInstallerTests.snapshot
    run_patch = fixtures.FetchInstallerTests.run_patch
    rejected_unchanged = fixtures.FetchInstallerTests.rejected_unchanged

    def save_manifest(self):
        data = fixtures.manifest(self.runtime)
        data['appVersion'] = '6.1.9'
        (self.runtime / 'manifest.json').write_text(json.dumps(data))

    def prepare_bundles(self):
        for name in ('cli.js', 'browser-helper.cjs'):
            (self.runtime / 'app' / name).write_text('\n'.join(old for old, _ in module.replacements(name)))
        self.save_manifest()

    def test_619_prevalidation_idempotence_and_backup(self):
        self.prepare_bundles()
        before = self.snapshot()
        r = self.run_patch('patch-browser-rebinding-619.py', '--dry-run')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.snapshot(), before)
        (self.runtime / 'app/browser-helper.cjs').write_text('unsupported bundle')
        self.save_manifest()
        self.rejected_unchanged('patch-browser-rebinding-619.py')
        self.prepare_bundles()
        r = self.run_patch('patch-browser-rebinding-619.py')
        self.assertEqual(r.returncode, 0, r.stderr)
        installed = self.snapshot()
        r = self.run_patch('patch-browser-rebinding-619.py')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.snapshot(), installed)
        self.assertEqual(len(list((self.runtime.parent / 'codex-web-stability-backups').iterdir())), 1)

    def test_619_wrong_version_corruption_and_partial_patch(self):
        self.prepare_bundles()
        path = self.runtime / 'manifest.json'
        data = json.loads(path.read_text())
        data['appVersion'] = '6.1.7'
        path.write_text(json.dumps(data))
        self.rejected_unchanged('patch-browser-rebinding-619.py')
        self.prepare_bundles()
        (self.runtime / 'app/cli.js').write_text('corrupted')
        self.rejected_unchanged('patch-browser-rebinding-619.py')
        self.prepare_bundles()
        p = self.runtime / 'app/cli.js'
        p.write_text(p.read_text().replace(*module.replacements('cli.js')[0]))
        self.save_manifest()
        self.rejected_unchanged('patch-browser-rebinding-619.py')

    def test_619_second_write_failure_rolls_back(self):
        self.prepare_bundles()
        before = self.snapshot()
        original = Path.write_text

        def fail_second(p, *args, **kwargs):
            if p == self.runtime / 'app/browser-helper.cjs':
                raise OSError('fixture write failure')
            return original(p, *args, **kwargs)

        with patch('sys.argv', ['patch', str(self.runtime)]), patch.object(Path, 'write_text', fail_second):
            with self.assertRaisesRegex(OSError, 'fixture write failure'):
                module.main()
        self.assertEqual(self.snapshot(), before)
