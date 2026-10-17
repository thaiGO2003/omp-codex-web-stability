import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('composer_install', ROOT / 'bin/apply-composer-check.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ComposerCheckInstallTests(unittest.TestCase):
    def original(self):
        source = (ROOT / 'shim/tool-call-ids.ts').read_text()
        source = source.split('\n// This UI precondition', 1)[0].replace('      normalizeComposerFailure(value);\n', '')
        self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), installer.KNOWN['tool-call-ids.ts'])
        return source

    def test_preview_apply_and_idempotence(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            target = directory / 'tool-call-ids.ts'
            original = self.original()
            target.write_text(original)
            installer.install(directory, dry_run=True)
            self.assertEqual(target.read_text(), original)
            installer.install(directory)
            self.assertEqual(target.read_bytes(), (ROOT / 'shim/tool-call-ids.ts').read_bytes())
            backups = list(directory.glob('*.bak'))
            installer.install(directory)
            self.assertEqual(list(directory.glob('*.bak')), backups)

    def test_unknown_layout_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / 'tool-call-ids.ts'
            target.write_text('custom')
            with self.assertRaises(ValueError):
                installer.install(Path(d))
            self.assertEqual(target.read_text(), 'custom')
            self.assertEqual(list(Path(d).glob('*.bak')), [])

    def test_failed_replace_restores_original(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / 'tool-call-ids.ts'
            original = self.original()
            target.write_text(original)
            with patch.object(Path, 'replace', side_effect=OSError('fixture')):
                with self.assertRaises(OSError):
                    installer.install(Path(d))
            self.assertEqual(target.read_text(), original)
            self.assertEqual(list(Path(d).glob('*.tmp')), [])
