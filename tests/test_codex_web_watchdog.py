import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest

from test_web_setup import POWERSHELL

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'bin' / 'watch-codex-web.ps1'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def dead_url():
    return f'http://127.0.0.1:{free_port()}'


class HealthHandler(http.server.BaseHTTPRequestHandler):
    payload = {'service': 'codex-chatgpt-web', 'status': 'ok', 'version': '6.1.9',
               'pid': 1234, 'accepting_turns': True, 'active_http_turns': 0, 'active_browser_turns': 0}

    def log_message(self, *_args):
        pass

    def do_GET(self):
        body = json.dumps(self.payload).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='watchdog Việt Nam ')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.server = None

    def run_watchdog(self, *args, url=None):
        return subprocess.run([
            POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', str(SCRIPT), '-Once', '-NoAutoUpdate',
            '-HomeDirectory', str(self.home), '-UpstreamUrl', url or dead_url(), *args,
        ], capture_output=True, text=True, timeout=60)

    def serve_health(self, **overrides):
        payload = {**HealthHandler.payload, **overrides}

        class Handler(HealthHandler):
            pass

        Handler.payload = payload
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return f'http://127.0.0.1:{self.server.server_port}'

    @unittest.skipUnless(POWERSHELL, 'PowerShell required')
    def test_healthy_upstream_is_reported_and_does_not_restart(self):
        url = self.serve_health()
        result = self.run_watchdog('-DryRun', url=url)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn('Codex Web is healthy', result.stdout)
        self.assertNotIn('Restarting Codex Web', result.stdout)

    @unittest.skipUnless(POWERSHELL, 'PowerShell required')
    def test_unreachable_upstream_is_reported(self):
        result = self.run_watchdog('-DryRun')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn('not reachable', result.stdout)

    @unittest.skipUnless(POWERSHELL, 'PowerShell required')
    def test_stopped_turn_acceptance_is_reported_as_degraded(self):
        url = self.serve_health(accepting_turns=False)
        result = self.run_watchdog('-DryRun', '-StuckSeconds', '15', url=url)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn('not accepting turns', result.stdout)

    @unittest.skipUnless(POWERSHELL, 'PowerShell required')
    def test_install_task_dry_run_reports_the_scheduled_task(self):
        result = self.run_watchdog('-DryRun', '-InstallTask')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("Would register scheduled task 'OMP Codex Web Watchdog'", result.stdout)


class WatchdogPackagingTests(unittest.TestCase):
    def test_standalone_installer_embeds_the_watchdog(self):
        text = (ROOT / 'install.ps1').read_text()
        self.assertIn('watch-codex-web.ps1', text)
        self.assertIn('OMP Codex Web Watchdog', text)
        self.assertTrue((ROOT / 'bin' / 'watch-codex-web.ps1').is_file())

    def test_standalone_installer_skips_unwritable_helpers(self):
        text = (ROOT / 'install.ps1').read_text()
        self.assertIn('Test-HelperWritable', text)
        self.assertIn('needs Administrator', text)

    def test_launcher_script_exists_and_elevates(self):
        launcher = ROOT / 'install-and-run.bat'
        self.assertTrue(launcher.is_file())
        self.assertFalse((ROOT / 'install.bat').exists())
        text = launcher.read_text()
        self.assertIn('fltmc', text)
        self.assertIn('-Verb RunAs', text)
