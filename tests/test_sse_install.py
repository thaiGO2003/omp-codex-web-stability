import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watchdog_install', Path(__file__).resolve().parents[1] / 'bin/apply-sse-watchdog.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

# Representative unpatched layout. Unrelated request/response paths must survive.
ORIGINAL = '''import { isAbsolute } from "node:path";
const upstreamOrigin = "http://127.0.0.1:17841";
const threadTails = new Map<string, Promise<void>>();
function threadIdFromMetadata(raw?: string) { return raw; }
function fetch(req: Request) {
    const headerTurnMetadata = req.headers.get("x-codex-turn-metadata") ?? undefined;
    let threadId = threadIdFromMetadata(headerTurnMetadata);
    const rewrittenTurnMetadata = "{}";
    const metadata = JSON.parse(rewrittenTurnMetadata!);
    const upstream = new Response();
    const isOmpStream = true;
    const responseBody = isOmpStream ? translateResponseStream(upstream.body!) : upstream.body;
    return new Response(responseBody); // keep existing response handling
}
'''


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='watchdog install ')
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name)
        self.server = self.target / 'server.ts'
        self.server.write_text(ORIGINAL)

    def test_installs_then_is_idempotent_and_preserves_existing_handling(self):
        installer.install(self.target)
        installed = self.server.read_text()
        self.assertIn(installer.NEW_BODY, installed)
        self.assertIn('return new Response(responseBody); // keep existing response handling', installed)
        self.assertTrue((self.target / 'sse-watchdog.ts').is_file())
        backups = list(self.target.glob('*.bak'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), ORIGINAL)
        installer.install(self.target)
        self.assertEqual(self.server.read_text(), installed)
        self.assertEqual(list(self.target.glob('*.bak')), backups)

    def test_dry_run_makes_no_files_or_changes(self):
        installer.install(self.target, dry_run=True)
        self.assertEqual(self.server.read_text(), ORIGINAL)
        self.assertEqual(list(self.target.iterdir()), [self.server])

    def test_unknown_or_partial_layout_refuses_without_modifying_files(self):
        for source in [ORIGINAL.replace(installer.OLD_BODY, 'custom handling'),
                       ORIGINAL + '\n' + installer.WATCHDOG_IMPORT,
                       ORIGINAL + '\n' + installer.OLD_BODY]:
            self.server.write_text(source)
            with self.assertRaises(ValueError):
                installer.install(self.target)
            self.assertEqual(self.server.read_text(), source)
            self.assertFalse((self.target / 'sse-watchdog.ts').exists())
            self.assertFalse(list(self.target.glob('*.bak')))

    def test_missing_shim_is_not_created(self):
        with self.assertRaises(ValueError):
            installer.install(self.target / 'missing')
        self.assertFalse((self.target / 'missing').exists())

    def test_write_failure_restores_server_and_removes_new_module(self):
        write = Path.write_text
        def fail_module(path, *args, **kwargs):
            if path.name == 'sse-watchdog.ts':
                raise OSError('simulated failed write')
            return write(path, *args, **kwargs)
        with patch.object(Path, 'write_text', fail_module):
            with self.assertRaises(OSError):
                installer.install(self.target)
        self.assertEqual(self.server.read_text(), ORIGINAL)
        self.assertFalse((self.target / 'sse-watchdog.ts').exists())
