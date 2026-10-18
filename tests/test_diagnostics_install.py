import importlib.util
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SHIM_PORT = re.search(r'OMP_CODEX_WEB_SHIM_PORT \|\| (\d+)', (ROOT / 'shim/server.ts').read_text()).group(1)
spec = importlib.util.spec_from_file_location('diagnostics_install', ROOT / 'bin/apply-diagnostics.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DiagnosticsInstallTests(unittest.TestCase):
    def original(self):
        source = (ROOT / 'shim/server.ts').read_text()
        for p in reversed(installer.PATCHES):
            source = source.replace(p['new'], p['old'], 1)
        return source

    def test_apply_preserves_custom_layout_and_is_idempotent(self):
        for legacy in (False, True):
            with tempfile.TemporaryDirectory() as d:
                target = Path(d)
                server = target / 'server.ts'
                original = self.original().replace(DEFAULT_SHIM_PORT, '18842')
                if legacy:
                    p = next(p for p in installer.PATCHES if p.get('alternatives'))
                    original = original.replace(p['old'], '')
                server.write_text(original)
                installer.install(target, dry_run=True)
                self.assertEqual(list(target.iterdir()), [server])
                installer.install(target)
                self.assertIn('18842', server.read_text())
                self.assertIn('diagnostics.status()', server.read_text())
                self.assertTrue((target / 'diagnostics.ts').is_file())
                before = server.read_text()
                backups = list(target.glob('*.bak'))
                installer.install(target)
                self.assertEqual(server.read_text(), before)
                self.assertEqual(list(target.glob('*.bak')), backups)

    def test_unknown_and_partial_layouts_refuse(self):
        source = self.original()
        p = installer.PATCHES[0]
        for invalid in ('custom', source.replace(p['old'], p['new'], 1)):
            with self.assertRaises(ValueError):
                installer.patched_server(invalid)

    def test_entrypoint_write_failure_rolls_back_dependencies(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d)
            server = target / 'server.ts'
            original = self.original()
            server.write_text(original)
            original_replace = Path.replace
            def fail(path, *args, **kwargs):
                if path.name == 'server.ts.diagnostics.tmp':
                    raise OSError('fixture')
                return original_replace(path, *args, **kwargs)
            with patch.object(Path, 'replace', fail):
                with self.assertRaises(OSError):
                    installer.install(target)
            self.assertEqual(server.read_text(), original)
            self.assertFalse((target / 'diagnostics.ts').exists())
            self.assertFalse((target / 'sse-watchdog.ts').exists())
            self.assertEqual(list(target.glob('*.tmp')), [])
