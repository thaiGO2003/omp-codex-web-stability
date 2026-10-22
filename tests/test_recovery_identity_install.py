import importlib.util
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SHIM_PORT = re.search(r'OMP_CODEX_WEB_SHIM_PORT \|\| (\d+)', (ROOT / 'shim/server.ts').read_text()).group(1)
spec = importlib.util.spec_from_file_location('recovery_install', ROOT / 'bin/apply-recovery-identity.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class RecoveryIdentityInstallTests(unittest.TestCase):
    def original(self):
        # Use a pinned supported installer fixture, not the evolving live shim.
        source = (ROOT / 'tests/fixtures/shim-server-2026-10-20.ts').read_text()
        for p in installer.PATCHES:
            source = source.replace(p['new'], p['old'], 1)
        return source

    def test_dry_run_apply_idempotence_and_preserved_custom_settings(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d)
            server = target / 'server.ts'
            original = self.original().replace(DEFAULT_SHIM_PORT, '18842')
            server.write_text(original)
            installer.install(target, dry_run=True)
            self.assertEqual(server.read_text(), original)
            self.assertFalse((target / 'sse-watchdog.ts').exists())
            installer.install(target)
            self.assertIn('18842', server.read_text())
            self.assertIn('recoveryIdentities.rotate', server.read_text())
            before = server.read_text()
            backups = list(target.glob('*.bak'))
            installer.install(target)
            self.assertEqual(server.read_text(), before)
            self.assertEqual(list(target.glob('*.bak')), backups)

    def test_unknown_or_partial_layout_refuses_before_writes(self):
        for source in ['custom', self.original().replace(installer.PATCHES[0]['old'], installer.PATCHES[0]['new'])]:
            with self.assertRaises(ValueError):
                installer.patched_server(source)

    def test_upgrade_known_earlier_identity_patch(self):
        current = (ROOT / 'tests/fixtures/shim-server-2026-10-20.ts').read_text()
        previous = current
        for p in installer.UPGRADES:
            previous = previous.replace(p['new'], p['old'], 1)
        self.assertNotEqual(previous, current)
        self.assertEqual(installer.patched_server(previous), current)

    def test_module_write_failure_restores_server(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d)
            server = target / 'server.ts'
            original = self.original()
            server.write_text(original)
            write = Path.write_text
            def fail_module(path, *args, **kwargs):
                if path.name == 'sse-watchdog.ts':
                    raise OSError('fixture write failure')
                return write(path, *args, **kwargs)
            with patch.object(Path, 'write_text', fail_module):
                with self.assertRaises(OSError):
                    installer.install(target)
            self.assertEqual(server.read_text(), original)
            self.assertFalse((target / 'sse-watchdog.ts').exists())
