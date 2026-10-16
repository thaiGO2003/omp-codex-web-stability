import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "bin/patch-read-gateway-619.py"
ANCHOR = 'n.registerTool("codex_tool_call",{title:"Call any tool"'


class ReadGateway619Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temp.name) / "6.1.9-linux-x64"
        (self.runtime / "app").mkdir(parents=True)
        source = "prefix;" + ANCHOR + ";suffix"
        (self.runtime / "app/cli.js").write_text(source)
        digest = hashlib.sha256(source.encode()).hexdigest()
        manifest = {
            "appVersion": "6.1.9", "platform": "linux", "arch": "x64", "bundleId": "fixture",
            "files": [{"path": "app/cli.js", "size": len(source.encode()), "sha256": digest}],
        }
        (self.runtime / "manifest.json").write_text(json.dumps(manifest))

    def tearDown(self):
        self.temp.cleanup()

    def run_patch(self, *extra):
        return subprocess.run(["python3", str(SCRIPT), str(self.runtime), *extra], text=True, capture_output=True)

    def test_dry_run_apply_and_idempotence(self):
        before = (self.runtime / "app/cli.js").read_text()
        result = self.run_patch("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.runtime / "app/cli.js").read_text(), before)
        result = self.run_patch()
        self.assertEqual(result.returncode, 0, result.stderr)
        source = (self.runtime / "app/cli.js").read_text()
        self.assertEqual(source.count('n.registerTool("codex_read"'), 1)
        self.assertIn("readOnlyHint:!0", source)
        self.assertIn('ut(m)==="read"', source)
        self.assertIn("cannot call shell, write, edit, patch, network, or arbitrary tools", source)
        manifest = json.loads((self.runtime / "manifest.json").read_text())
        self.assertEqual(manifest["files"][0]["size"], len(source.encode()))
        self.assertEqual(manifest["files"][0]["sha256"], hashlib.sha256(source.encode()).hexdigest())
        snapshot = ((self.runtime / "app/cli.js").read_bytes(), (self.runtime / "manifest.json").read_bytes())
        result = self.run_patch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(snapshot, ((self.runtime / "app/cli.js").read_bytes(), (self.runtime / "manifest.json").read_bytes()))

    def test_rejects_manifest_mismatch_and_wrong_version(self):
        path = self.runtime / "app/cli.js"
        path.write_text(path.read_text() + "corrupt")
        result = self.run_patch()
        self.assertNotEqual(result.returncode, 0)
        manifest_path = self.runtime / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["appVersion"] = "6.1.7"
        manifest_path.write_text(json.dumps(manifest))
        result = self.run_patch()
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
