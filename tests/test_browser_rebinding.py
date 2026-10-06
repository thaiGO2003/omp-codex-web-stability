import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rebinding', ROOT/'bin/apply-browser-rebinding.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MANIFEST = json.loads((ROOT/'fixes/browser-rebinding.json').read_text())
ORIGINAL = 'header\n' + '\n'.join(p['old'] for p in MANIFEST['patches']) + '\nfooter\n'
PREVIOUS = 'header\n' + '\n'.join(p['new'] for p in MANIFEST['previousPatches']) + '\nfooter\n'

class RebindingTests(unittest.TestCase):
    def test_guards_and_idempotence(self):
        patched, changed = module.patch_text(ORIGINAL, MANIFEST)
        self.assertTrue(changed)
        self.assertEqual(module.patch_text(patched, MANIFEST), (patched, False))
        self.assertEqual(module.patch_text(PREVIOUS, MANIFEST), (patched, True))
        for layout in MANIFEST['previousLayouts']:
            previous = 'header\n' + '\n'.join(p['new'] for p in layout['patches']) + '\nfooter\n'
            self.assertEqual(module.patch_text(previous, MANIFEST), (patched, True))
        for text in ['unknown', ORIGINAL+ORIGINAL, ORIGINAL.replace(MANIFEST['patches'][0]['old'], MANIFEST['patches'][0]['new'])]:
            with self.assertRaises(ValueError):
                module.patch_text(text, MANIFEST)

    def test_python_installer_prevalidates_all_targets_and_backs_up(self):
        with tempfile.TemporaryDirectory() as directory:
            helper = Path(directory)/'browser-helper.cjs'
            other = Path(directory)/'other.cjs'
            helper.write_text(ORIGINAL)
            other.write_text('unknown')
            command = ['python3',str(ROOT/'bin/apply-browser-rebinding.py'),'--helper',str(helper)]
            result = subprocess.run(command+['--helper',str(other)],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(helper.read_text(),ORIGINAL)
            subprocess.run(command+['--dry-run'],check=True,capture_output=True)
            self.assertEqual(helper.read_text(),ORIGINAL)
            subprocess.run(command,check=True,capture_output=True)
            backups = list(Path(directory).glob('*.bak'))
            self.assertEqual(len(backups),1)
            self.assertEqual(backups[0].read_text(),ORIGINAL)
            subprocess.run(command,check=True,capture_output=True)
            self.assertEqual(len(list(Path(directory).glob('*.bak'))),1)

    def test_powershell_installer_has_same_patch_guards_and_output(self):
        shell = os.environ.get('POWERSHELL_EXE') or shutil.which('pwsh')
        if not shell:
            self.skipTest('PowerShell unavailable')
        with tempfile.TemporaryDirectory() as directory:
            helper = Path(directory)/'browser-helper.cjs'
            helper.write_text(ORIGINAL)
            command = [shell,'-NoProfile','-File',str(ROOT/'bin/apply-browser-rebinding.ps1'),'-HelperPath',str(helper)]
            subprocess.run(command+['-DryRun'],check=True,capture_output=True)
            self.assertEqual(helper.read_text(),ORIGINAL)
            subprocess.run(command,check=True,capture_output=True)
            self.assertEqual(helper.read_text(),module.patch_text(ORIGINAL,MANIFEST)[0])
            subprocess.run(command,check=True,capture_output=True)
            self.assertEqual(len(list(Path(directory).glob('*.bak'))),1)
            helper.write_text(PREVIOUS)
            subprocess.run(command,check=True,capture_output=True)
            self.assertEqual(helper.read_text(),module.patch_text(ORIGINAL,MANIFEST)[0])
            self.assertEqual(len(list(Path(directory).glob('*.bak'))),2)
            for layout in MANIFEST['previousLayouts']:
                helper.write_text('header\n' + '\n'.join(p['new'] for p in layout['patches']) + '\nfooter\n')
                subprocess.run(command,check=True,capture_output=True)
                self.assertEqual(helper.read_text(),module.patch_text(ORIGINAL,MANIFEST)[0])
            helper.write_text('unknown')
            self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
            self.assertEqual(helper.read_text(),'unknown')
