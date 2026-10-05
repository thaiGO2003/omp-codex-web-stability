import os
from pathlib import Path
import shutil
import subprocess
import unittest
import test_sse_install as fixture

ORIGINAL = fixture.ORIGINAL
installer = fixture.installer

POWERSHELL = os.environ.get('POWERSHELL_EXE') or shutil.which('pwsh') or shutil.which('powershell')
SCRIPT = Path(__file__).resolve().parents[1] / 'bin/apply-sse-watchdog.ps1'


@unittest.skipUnless(POWERSHELL, 'PowerShell runtime not installed (set POWERSHELL_EXE)')
class PowerShellInstallerTests(unittest.TestCase):
    setUp = fixture.InstallerTests.setUp

    def run_script(self, *args):
        return subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
                               '-ShimDirectory', str(self.target), '-SkipOmpConfig', *args], capture_output=True, text=True, timeout=20)

    def test_native_install_matches_python_and_is_idempotent(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.server.read_text(), installer.patched_server(ORIGINAL))
        self.assertTrue((self.target / 'sse-watchdog.ts').is_file())
        backups = list(self.target.glob('*.bak'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), ORIGINAL)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('already installed', result.stdout)
        self.assertEqual(list(self.target.glob('*.bak')), backups)

    def test_dry_run_does_not_write(self):
        result = self.run_script('-DryRun')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.server.read_text(), ORIGINAL)
        self.assertEqual(list(self.target.iterdir()), [self.server])

    def test_preserves_crlf_and_unicode_and_accepts_bom(self):
        source = ('// Vietnamese: Việt Nam\n' + ORIGINAL).replace('\n', '\r\n')
        self.server.write_bytes(source.encode('utf-8-sig'))
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = self.server.read_bytes().decode('utf-8')
        self.assertIn('Việt Nam', installed)
        self.assertNotIn('\n', installed.replace('\r\n', ''))
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(len(list(self.target.glob('*.bak'))), 1)

    def test_unknown_and_partial_layouts_refuse_without_changes(self):
        for source in [ORIGINAL.replace(installer.OLD_BODY, 'custom handling'),
                       ORIGINAL + '\n' + installer.WATCHDOG_IMPORT]:
            self.server.write_text(source)
            result = self.run_script()
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.server.read_text(), source)
            self.assertEqual(list(self.target.iterdir()), [self.server])

    def test_write_failure_rolls_back_server(self):
        # A directory at the destination forces module installation to fail.
        module = self.target / 'sse-watchdog.ts'
        module.mkdir()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.server.read_text(), ORIGINAL)
        self.assertTrue(module.is_dir())

    def test_standalone_script_works_without_companion_files(self):
        standalone = self.target / 'installer with spaces.ps1'
        standalone.write_bytes(SCRIPT.read_bytes())
        result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(standalone),
                                 '-ShimDirectory', str(self.target), '-SkipOmpConfig'], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.server.read_text(), installer.patched_server(ORIGINAL))
        source = SCRIPT.parent.parent / 'fixes/sse-watchdog.ts'
        self.assertEqual((self.target / 'sse-watchdog.ts').read_text(), source.read_text())


BUN = os.environ.get('BUN_EXE') or shutil.which('bun')


@unittest.skipUnless(POWERSHELL and BUN, 'PowerShell and Bun required')
class PowerShellConfigTests(unittest.TestCase):
    setUp = fixture.InstallerTests.setUp

    def run_script(self, *args):
        return subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
                               '-BunPath', BUN, '-OmpConfigPath', str(self.target / 'config.yml'),
                               '-ShimDirectory', str(self.target), *args], capture_output=True, text=True, timeout=20)

    def test_config_only_backs_up_and_preserves_models_and_other_settings(self):
        config = self.target / 'config.yml'
        original = ('modelRoles:\r\n  default: my-provider/my-model\r\n'
                    '  judge: my-router/my-judge\r\ncompaction:\r\n'
                    '  methodOrder: [remote, soft]\r\n  autoContinue: true\r\n')
        config.write_bytes(original.encode('utf-8'))
        result = self.run_script('-ConfigOnly')
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = config.read_bytes().decode()
        self.assertIn('my-provider/my-model', updated)
        self.assertIn('my-router/my-judge', updated)
        self.assertIn('autoContinue: true', updated)
        self.assertIn('shake', updated)
        self.assertIn('handoff', updated)
        self.assertNotIn('soft', updated)
        self.assertNotIn('\n', updated.replace('\r\n', ''))
        backups = list(self.target.glob('config.yml*.bak'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original.encode())
        self.assertEqual(self.server.read_text(), ORIGINAL)
        self.assertEqual(self.run_script('-ConfigOnly').returncode, 0)
        self.assertEqual(list(self.target.glob('config.yml*.bak')), backups)

    def test_dry_run_does_not_create_config_or_patch_shim(self):
        result = self.run_script('-DryRun')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('config.yml', result.stdout)
        self.assertFalse((self.target / 'config.yml').exists())
        self.assertEqual(self.server.read_text(), ORIGINAL)
        self.assertEqual(list(self.target.iterdir()), [self.server])

    def test_default_run_writes_both_config_and_shim(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('shake', (self.target / 'config.yml').read_text())
        self.assertEqual(self.server.read_text(), installer.patched_server(ORIGINAL))

    def test_missing_shim_explains_config_only_and_does_not_write(self):
        self.server.unlink()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('-ConfigOnly', result.stderr)
        self.assertFalse((self.target / 'config.yml').exists())
        result = self.run_script('-ConfigOnly')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('shake', (self.target / 'config.yml').read_text())
        self.assertFalse(self.server.exists())

    def test_invalid_yaml_refuses_entire_install(self):
        config = self.target / 'config.yml'
        config.write_text('compaction: [')
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config.read_text(), 'compaction: [')
        self.assertEqual(self.server.read_text(), ORIGINAL)
        self.assertFalse(list(self.target.glob('*.bak')))

    def test_unknown_shim_refuses_config_write(self):
        self.server.write_text('unknown shim')
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.target / 'config.yml').exists())

    def test_module_write_failure_rolls_back_config_and_server(self):
        config = self.target / 'config.yml'
        config.write_text('theme: {dark: mine}\n')
        (self.target / 'sse-watchdog.ts').mkdir()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config.read_text(), 'theme: {dark: mine}\n')
        self.assertEqual(self.server.read_text(), ORIGINAL)
