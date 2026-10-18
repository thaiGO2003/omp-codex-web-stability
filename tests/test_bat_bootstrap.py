import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from test_web_setup import POWERSHELL

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(POWERSHELL, 'PowerShell required')
class BatBootstrapTests(unittest.TestCase):
    def test_real_bootstrap_updates_old_bundle_and_preserves_it_on_download_failure(self):
        text = (ROOT / 'install-and-run.bat').read_text()
        command = re.search(r'^"%stability_shell%" -NoProfile -ExecutionPolicy Bypass -Command "(.*)"$', text, re.M)[1]
        with tempfile.TemporaryDirectory(prefix="BAT path ! with spaces '") as directory:
            target = Path(directory) / 'install.ps1'
            env = {**os.environ, 'stability_script': str(target), 'bootstrap_fixture': str(ROOT / 'install.ps1')}
            mock = 'function Invoke-WebRequest { param([switch]$UseBasicParsing,$Uri,$OutFile); Copy-Item -LiteralPath $env:bootstrap_fixture -Destination $OutFile }; '
            target.write_text('old installer')
            result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', mock + command], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_bytes(), (ROOT / 'install.ps1').read_bytes())
            backups = list(Path(directory).glob('*.bak'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), 'old installer')
            before = target.read_bytes()
            for replacement in ['throw "fixture offline"', '[IO.File]::WriteAllText($OutFile,"<html>not a script</html>")', '[IO.File]::WriteAllText($OutFile,"# OMP-STABILITY-BUNDLE: 2026-10-16-lifecycle-619`nfunction {")']:
                bad = 'function Invoke-WebRequest { param([switch]$UseBasicParsing,$Uri,$OutFile); ' + replacement + ' }; '
                result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', bad + command], env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(target.read_bytes(), before)
                self.assertEqual(list(Path(directory).glob('*.download-*')), [])
                self.assertEqual(list(Path(directory).glob('*.bak')), backups)
