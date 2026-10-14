import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import test_fetch_installer as fixtures

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rebinding617', ROOT / 'bin/patch-browser-rebinding-617.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Rebinding617InstallerTests(unittest.TestCase):
    setUp = fixtures.FetchInstallerTests.setUp
    save_manifest = fixtures.FetchInstallerTests.save_manifest
    snapshot = fixtures.FetchInstallerTests.snapshot
    run_patch = fixtures.FetchInstallerTests.run_patch
    rejected_unchanged = fixtures.FetchInstallerTests.rejected_unchanged

    def test_rebinding_guards_prevalidate_both_bundles(self):
        for name in ('cli.js', 'browser-helper.cjs'):
            (self.runtime / 'app' / name).write_text('\n'.join(old for old, _ in module.replacements(name)))
        self.save_manifest()
        original = self.snapshot()
        result = self.run_patch('patch-browser-rebinding-617.py', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.snapshot(), original)
        (self.runtime / 'app/browser-helper.cjs').write_text('unknown second bundle')
        self.save_manifest()
        self.rejected_unchanged('patch-browser-rebinding-617.py')
        for name in ('cli.js', 'browser-helper.cjs'):
            (self.runtime / 'app' / name).write_bytes(original['app/' + name])
        self.save_manifest()
        result = self.run_patch('patch-browser-rebinding-617.py')
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = self.snapshot()
        result = self.run_patch('patch-browser-rebinding-617.py')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.snapshot(), installed)
        self.assertEqual(len(list((self.runtime.parent / 'codex-web-stability-backups').iterdir())), 1)

    def test_rebinding_refuses_corrupt_or_partial_layout(self):
        for name in ('cli.js', 'browser-helper.cjs'):
            (self.runtime / 'app' / name).write_text('\n'.join(old for old, _ in module.replacements(name)))
        self.save_manifest()
        (self.runtime / 'app/cli.js').write_text('corrupted')
        self.rejected_unchanged('patch-browser-rebinding-617.py')
        for name in ('cli.js', 'browser-helper.cjs'):
            pairs = module.replacements(name)
            source = '\n'.join(old for old, _ in pairs)
            if name == 'cli.js':
                source = source.replace(*pairs[0])
            (self.runtime / 'app' / name).write_text(source)
        self.save_manifest()
        self.rejected_unchanged('patch-browser-rebinding-617.py')

    def test_rebinding_refuses_unverified_versions_and_platforms(self):
        path = self.runtime / 'manifest.json'
        for key, value in [('appVersion', '6.1.6'), ('platform', 'win32'), ('arch', 'arm64')]:
            self.save_manifest()
            data = json.loads(path.read_text())
            data[key] = value
            path.write_text(json.dumps(data))
            self.rejected_unchanged('patch-browser-rebinding-617.py')

    def test_write_failure_restores_both_bundles_and_manifest(self):
        for name in ('cli.js', 'browser-helper.cjs'):
            (self.runtime / 'app' / name).write_text('\n'.join(old for old, _ in module.replacements(name)))
        self.save_manifest()
        before = self.snapshot()
        original_write = Path.write_text

        def fail_second(path, *args, **kwargs):
            if path == self.runtime / 'app/browser-helper.cjs':
                raise OSError('fixture second-bundle write failed')
            return original_write(path, *args, **kwargs)

        with patch('sys.argv', ['patch', str(self.runtime)]), patch.object(Path, 'write_text', fail_second):
            with self.assertRaisesRegex(OSError, 'second-bundle'):
                module.main()
        self.assertEqual(self.snapshot(), before)
