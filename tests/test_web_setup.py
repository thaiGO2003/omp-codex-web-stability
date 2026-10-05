import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request

POWERSHELL = os.environ.get('POWERSHELL_EXE') or shutil.which('pwsh') or shutil.which('powershell')
BUN = os.environ.get('BUN_EXE') or shutil.which('bun')
SCRIPT = Path(__file__).resolve().parents[1] / 'bin/setup-omp-codex-web.ps1'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Bridge(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_json({'data': [{'id': 'chatgpt-web/gpt-5.6-sol'}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_json({'path': self.path, 'body': body,
                        'turnMetadata': json.loads(self.headers['x-codex-turn-metadata'])})


@unittest.skipUnless(POWERSHELL and BUN, 'PowerShell and Bun required')
class WebSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='OMP Web Việt Nam ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.agent = self.root / 'agent with spaces'
        self.shim = self.root / 'new shim'
        self.shim_port = free_port()
        self.bridge = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Bridge)
        thread = threading.Thread(target=self.bridge.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.bridge.server_close)
        self.addCleanup(self.bridge.shutdown)
        self.upstream = f'http://127.0.0.1:{self.bridge.server_port}'

    def run_setup(self, *args, script=SCRIPT):
        return subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(script),
                               '-BunPath', BUN, '-AgentDirectory', str(self.agent),
                               '-ShimDirectory', str(self.shim), '-UpstreamUrl', self.upstream,
                               '-ShimPort', str(self.shim_port), '-NoStart', *args],
                              capture_output=True, text=True, timeout=25)

    def test_standalone_installs_roles_providers_and_base_shim_then_forwards_a_tool_request(self):
        standalone = self.root / 'setup downloaded alone.ps1'
        standalone.write_bytes(SCRIPT.read_bytes())
        result = self.run_setup(script=standalone)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Sol is listed', result.stdout)
        self.assertTrue((self.agent / 'extensions/codex-chatgpt-web-compat.ts').is_file())
        self.assertIn('codex-chatgpt-web/chatgpt-web/gpt-5.6-sol:high', (self.agent / 'config.yml').read_text())
        self.assertIn(f'http://127.0.0.1:{self.shim_port}/v1', (self.agent / 'models.yml').read_text())
        process = subprocess.Popen([POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(self.shim / 'start-shim.ps1')],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=(os.name != 'nt'))
        try:
            origin = f'http://127.0.0.1:{self.shim_port}'
            for _ in range(60):
                try:
                    with urllib.request.urlopen(origin + '/omp-shim-health', timeout=0.2) as response:
                        health = json.load(response)
                    break
                except OSError:
                    time.sleep(0.05)
            else:
                self.fail('Installed shim did not start')
            self.assertEqual(health['upstreamOrigin'], self.upstream)
            payload = {
                '__omp_cwd': str(self.root), 'model': 'chatgpt-web/gpt-5.6-sol',
                'client_metadata': {'x-codex-turn-metadata': json.dumps({'thread_id': 'test-thread', 'turn_id': 'test-turn'})},
                'input': [{'role': 'user', 'content': 'test'},
                          {'type': 'function_call_output', 'call_id': 'call_test__omp', 'output': 'OK'}],
            }
            # The extension's body cwd suffices even without command-backed headers.
            request = urllib.request.Request(origin + '/v1/codex/responses', data=json.dumps(payload).encode(),
                                             headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=3) as response:
                forwarded = json.load(response)
            self.assertEqual(forwarded['path'], '/v1/responses')
            self.assertNotIn('__omp_cwd', forwarded['body'])
            self.assertEqual(forwarded['turnMetadata']['workspaces'], {str(self.root): {}})
            self.assertEqual(forwarded['body']['input'][-1]['call_id'], 'call_test_')
        finally:
            if os.name != 'nt':
                import signal
                os.killpg(process.pid, signal.SIGTERM)
            else:
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
            process.wait(timeout=5)

    def test_preserves_unicode_config_and_existing_credentials_and_is_idempotent(self):
        self.agent.mkdir()
        config = self.agent / 'config.yaml'
        models = self.agent / 'models.yaml'
        config.write_text('theme: {dark: "Việt Nam"}\nmodelRoles: {judge: keep/judge}\ncompaction: {methodOrder: [soft]}\n')
        models.write_text('providers: {other: {apiKey: local-secret-placeholder}}\n')
        original = config.read_bytes()
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Việt Nam', config.read_text())
        self.assertIn('keep/judge', config.read_text())
        self.assertIn('soft', config.read_text())
        self.assertIn('local-secret-placeholder', models.read_text())
        self.assertNotIn('local-secret-placeholder', result.stdout + result.stderr)
        backups = list(self.agent.glob('*.bak'))
        self.assertEqual(len(backups), 2)
        self.assertEqual(next(self.agent.glob('config.yaml*.bak')).read_bytes(), original)
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.agent.glob('*.bak')), backups)

    def test_dry_run_and_invalid_yaml_do_not_create_a_shim(self):
        result = self.run_setup('-DryRun', '-JudgeBaseUrl', 'http://localhost:20218')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.shim.exists())
        self.assertFalse(self.agent.exists())
        self.agent.mkdir()
        config = self.agent / 'config.yml'
        config.write_text('modelRoles: []\n')
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config.read_text(), 'modelRoles: []\n')
        self.assertFalse(self.shim.exists())
        self.assertFalse(list(self.agent.glob('*.bak')))

    def test_write_failure_restores_config_models_and_new_shim_files(self):
        self.agent.mkdir()
        config = self.agent / 'config.yml'
        models = self.agent / 'models.yml'
        config.write_text('theme: {dark: original}\n')
        models.write_text('providers: {}\n')
        (self.shim / 'task-label.ts').mkdir(parents=True)
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config.read_text(), 'theme: {dark: original}\n')
        self.assertEqual(models.read_text(), 'providers: {}\n')
        self.assertFalse((self.shim / 'server.ts').exists())
        self.assertTrue((self.shim / 'task-label.ts').is_dir())
