import json
import os
import hashlib
from pathlib import Path
import re
import subprocess
import unittest

import test_web_setup as web_setup

BUN = web_setup.BUN
POWERSHELL = web_setup.POWERSHELL

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(POWERSHELL and BUN, 'PowerShell and Bun required')
class WindowsInstallTests(unittest.TestCase):
    setUp = web_setup.WebSetupTests.setUp

    def helper(self, version='6.1.6'):
        path = self.root / 'versions' / f'{version}-win32-x64' / 'app/browser-helper.cjs'
        path.parent.mkdir(parents=True)
        path.write_text('const stages={send:20000,multipartStageSend:180000};'
                        'const probe=opts.selectorTimeoutMs??5000;')
        return path

    def run_install(self, helper, *args, standalone=False, bun=BUN):
        script = ROOT / 'install.ps1'
        if standalone:
            script = self.root / 'download with spaces Việt Nam' / 'install.ps1'
            script.parent.mkdir(exist_ok=True)
            script.write_bytes((ROOT / 'install.ps1').read_bytes())
        return subprocess.run([
            POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(script),
            '-BunPath', bun, '-AgentDirectory', str(self.agent), '-ShimDirectory', str(self.shim),
            '-UpstreamUrl', self.upstream, '-ShimPort', str(self.shim_port),
            '-HelperPath', str(helper), '-NoStart', *args,
        ], capture_output=True, text=True, timeout=60)

    def test_standalone_installs_latest_fixes_and_preserves_credentials_idempotently(self):
        helper = self.helper()
        original_helper = helper.read_bytes()
        self.agent.mkdir()
        config = self.agent / 'config.yaml'
        models = self.agent / 'models.yaml'
        config.write_text('theme: {dark: "Việt Nam"}\nmodelRoles: {judge: keep/judge}\n'
                          'compaction: {methodOrder: [soft]}\n')
        models.write_text('providers: {other: {apiKey: local-secret-placeholder}}\n')
        original_config = config.read_bytes()
        result = self.run_install(helper, standalone=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn('Saved-turn rebinding patch is only for 6.1.4; skipped', result.stdout)
        self.assertIn('Việt Nam', config.read_text())
        self.assertIn('codex-chatgpt-web/chatgpt-web/gpt-6-sol-instant:auto', config.read_text())
        self.assertIn('advisor: codex-chatgpt-web/chatgpt-web/gpt-6-sol:high', config.read_text())
        self.assertIn('memory: codex-chatgpt-web/chatgpt-web/gpt-5.6-sol:high', config.read_text())
        self.assertNotIn('keep/judge', config.read_text())
        self.assertIn('shake', config.read_text())
        self.assertIn('handoff', config.read_text())
        self.assertNotIn('soft', config.read_text())
        self.assertIn('gpt-6-sol:high', config.read_text())
        self.assertIn('local-secret-placeholder', models.read_text())
        self.assertNotIn('local-secret-placeholder', result.stdout + result.stderr)
        self.assertIn('guardResponseStream', (self.shim / 'server.ts').read_text())
        self.assertTrue((self.shim / 'sse-watchdog.ts').exists())
        self.assertIn('send:120000,', helper.read_text())
        self.assertIn('selectorTimeoutMs??30000', helper.read_text())
        self.assertIn('multipartStageSend:180000', helper.read_text())
        self.assertEqual(next(helper.parent.glob('*.bak')).read_bytes(), original_helper)
        self.assertTrue(any(p.read_bytes() == original_config for p in self.agent.glob('*.bak')))
        backups = sorted(self.root.rglob('*.bak'))
        result = self.run_install(helper)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(sorted(self.root.rglob('*.bak')), backups)

    def test_preview_and_invalid_helper_leave_all_installation_files_unchanged(self):
        helper = self.helper()
        original = helper.read_bytes()
        result = self.run_install(helper, '-DryRun')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(helper.read_bytes(), original)
        self.assertFalse(self.agent.exists())
        self.assertFalse(self.shim.exists())
        helper.write_text('send:20000,send:120000,')
        result = self.run_install(helper)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(helper.read_text(), 'send:20000,send:120000,')
        self.assertFalse(self.agent.exists())
        self.assertFalse(self.shim.exists())
        self.assertFalse(list(self.root.rglob('*.bak')))

    def test_614_uses_latest_connector_approval_and_model_picker_patch(self):
        helper = self.helper('6.1.4')
        manifest = json.loads((ROOT / 'fixes/browser-rebinding.json').read_text())
        helper.write_text(helper.read_text() + '\n'.join(p['old'] for p in manifest['patches']))
        result = self.run_install(helper)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        patched = helper.read_text()
        for patch in manifest['patches']:
            self.assertIn(patch['new'], patched)
        self.assertIn('send:120000,', patched)

    def test_missing_bun_reports_error_without_changes(self):
        helper = self.helper()
        original = helper.read_bytes()
        result = self.run_install(helper, bun=str(self.root / 'missing bun.exe'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Bun not found', result.stderr)
        self.assertEqual(helper.read_bytes(), original)
        self.assertFalse(self.agent.exists())
        self.assertFalse(self.shim.exists())

    @unittest.skipUnless(os.environ.get('CODEX_WEB_617_WINDOWS_RUNTIME'), 'Supply verified Windows 6.1.7 bundles')
    def test_617_standalone_preserves_manifest_and_reapplies_without_backups(self):
        vendor = Path(os.environ['CODEX_WEB_617_WINDOWS_RUNTIME'])
        helper = self.helper('6.1.7')
        runtime = helper.parent.parent
        for name in ['cli.js', 'browser-helper.cjs']:
            (runtime / 'app' / name).write_bytes((vendor / 'app' / name).read_bytes())
        manifest_path = runtime / 'manifest.json'
        manifest_path.write_bytes((vendor / 'manifest.json').read_bytes())
        before = {p: p.read_bytes() for p in [helper, runtime / 'app/cli.js', manifest_path]}
        result = self.run_install(helper, '-DryRun', standalone=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertFalse(self.agent.exists())
        self.assertFalse(self.shim.exists())
        result = self.run_install(helper, standalone=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        manifest = json.loads(manifest_path.read_text())
        for name in ['cli.js', 'browser-helper.cjs']:
            data = (runtime / 'app' / name).read_bytes()
            record = next(r for r in manifest['files'] if r['path'] == 'app/' + name)
            self.assertEqual(record['size'], len(data))
            self.assertEqual(record['sha256'], hashlib.sha256(data).hexdigest())
            self.assertIn(b'submittedAppMentionHref', data)
            self.assertIn(b'send:120000,', data)
        saved = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = self.run_install(helper)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}, saved)

    @unittest.skipUnless(os.environ.get('CODEX_WEB_617_WINDOWS_RUNTIME'), 'Supply verified Windows 6.1.7 bundles')
    def test_617_corrupt_second_bundle_prevents_config_and_runtime_writes(self):
        vendor = Path(os.environ['CODEX_WEB_617_WINDOWS_RUNTIME'])
        helper = self.helper('6.1.7')
        runtime = helper.parent.parent
        (runtime / 'app/cli.js').write_bytes((vendor / 'app/cli.js').read_bytes())
        (runtime / 'manifest.json').write_bytes((vendor / 'manifest.json').read_bytes())
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = self.run_install(helper)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual({p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}, before)
        self.assertFalse(self.agent.exists())
        self.assertFalse(self.shim.exists())

    @unittest.skipUnless(os.environ.get('CODEX_WEB_617_WINDOWS_RUNTIME') and os.name != 'nt', 'Linux host plus verified Windows bundles required')
    def test_617_write_failure_restores_first_bundle_and_manifest(self):
        vendor = Path(os.environ['CODEX_WEB_617_WINDOWS_RUNTIME'])
        helper = self.helper('6.1.7')
        runtime = helper.parent.parent
        for name in ['cli.js', 'browser-helper.cjs']:
            (runtime / 'app' / name).write_bytes((vendor / 'app' / name).read_bytes())
        (runtime / 'manifest.json').write_bytes((vendor / 'manifest.json').read_bytes())
        before = {p: p.read_bytes() for p in [helper, runtime / 'app/cli.js', runtime / 'manifest.json']}
        helper.chmod(0o444)
        result = self.run_install(helper)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertFalse(self.agent.exists())
        self.assertFalse(self.shim.exists())


class BundledPayloadTests(unittest.TestCase):
    def test_standalone_contains_current_scripts(self):
        text = (ROOT / 'install.ps1').read_text()
        payload = json.loads(re.search(r"\$payloadJson = @'\n(.*?)\n'@", text, re.S)[1])
        for name, embedded in payload['scripts'].items():
            self.assertEqual(embedded, (ROOT / 'bin' / name).read_text(), name)
