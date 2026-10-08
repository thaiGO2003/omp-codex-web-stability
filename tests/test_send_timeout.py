import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('send_budget', ROOT/'bin/apply-send-timeout.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SendBudgetTests(unittest.TestCase):
    def test_preserves_multipart_and_rejects_unknown_or_duplicate_budgets(self):
        for budget in [20000, 60000, 120000]:
            original = f'const stages={{send:{budget},multipartStageSend:180000}};'
            updated, changed = module.patch_text(original)
            self.assertEqual(updated, 'const stages={send:120000,multipartStageSend:180000};')
            self.assertEqual(changed, budget != 120000)
            self.assertEqual(module.patch_text(updated), (updated, False))
        for original in ['unknown', 'send:20000,send:20000,', 'send:20000,send:120000,']:
            with self.assertRaises(ValueError): module.patch_text(original)

    def exercise_installer(self, command, helper, other, dry_flag, helper_flag):
        original = 'const stages={send:20000,multipartStageSend:180000};'
        helper.write_text(original); other.write_text('unknown')
        cmd=command+[helper_flag,str(helper)]
        # A bad second target must not partially modify the valid first target.
        if helper_flag=='--helper':
            multi=cmd+[helper_flag,str(other)]
        else:
            quote=lambda value: "'"+str(value).replace("'","''")+"'"
            script="& "+quote(ROOT/'bin/apply-send-timeout.ps1')+" -HelperPath @("+quote(helper)+","+quote(other)+")"
            multi=[command[0],'-NoProfile','-Command',script]
        result=subprocess.run(multi,capture_output=True)
        self.assertNotEqual(result.returncode,0); self.assertEqual(helper.read_text(),original)
        subprocess.run(cmd+[dry_flag],check=True,capture_output=True)
        self.assertEqual(helper.read_text(),original)
        subprocess.run(cmd,check=True,capture_output=True)
        self.assertEqual(helper.read_text(),module.patch_text(original)[0])
        backups=list(helper.parent.glob('*.bak')); self.assertEqual(len(backups),1); self.assertEqual(backups[0].read_text(),original)
        subprocess.run(cmd,check=True,capture_output=True)
        self.assertEqual(len(list(helper.parent.glob('*.bak'))),1)

    def test_python_prevalidation_backup_and_idempotence(self):
        with tempfile.TemporaryDirectory() as directory:
            self.exercise_installer(['python3',str(ROOT/'bin/apply-send-timeout.py')],Path(directory)/'helper.cjs',Path(directory)/'bad.cjs','--dry-run','--helper')

    def test_powershell_prevalidation_backup_and_idempotence(self):
        shell=os.environ.get('POWERSHELL_EXE') or shutil.which('pwsh')
        if not shell:self.skipTest('PowerShell unavailable')
        with tempfile.TemporaryDirectory() as directory:
            self.exercise_installer([shell,'-NoProfile','-File',str(ROOT/'bin/apply-send-timeout.ps1')],Path(directory)/'helper.cjs',Path(directory)/'bad.cjs','-DryRun','-HelperPath')
