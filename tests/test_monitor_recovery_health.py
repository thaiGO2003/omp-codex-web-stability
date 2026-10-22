"""Test health monitoring without contacting services or sending notifications."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    'recovery_health_watch', ROOT / 'bin/monitor-recovery-health.py')
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class RecoveryHealthWatchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name) / 'state' / 'health.json'
        self.patch_state = patch.object(watch, 'STATE_PATH', self.state)
        self.patch_state.start()
        self.addCleanup(self.patch_state.stop)
        self.notifications = []
        notify = patch.object(watch, 'notify', self.notifications.append)
        notify.start()
        self.addCleanup(notify.stop)

    def test_healthy_service_and_native(self):
        values = [
            {'status': 'ok', 'version': '6.1.12', 'accepting_turns': True,
             'scoped_interrupt_settled': True},
            {'service': 'omp-codex-web-shim', 'upstreamOrigin': 'http://127.0.0.1:17841',
             'diagnostics': {'failedWrites': 0}},
        ]
        with patch.object(watch, 'read_health', side_effect=values):
            self.assertEqual(watch.check(), [])

    def test_health_endpoint_errors_and_invalid_payloads_are_reported(self):
        with patch.object(watch, 'read_health', side_effect=[OSError('offline'),
                                                            {'diagnostics': None}]):
            self.assertEqual(watch.check(), ['native_unreachable', 'shim_unready',
                                             'shim_diagnostics_failed'])

    def test_two_failures_alert_once_then_recovery_alerts_once(self):
        with patch.object(watch, 'check', side_effect=[['native_unreachable'],
                                                     ['native_unreachable'],
                                                     ['native_unreachable'], [], []]):
            observed = []
            for _ in range(5):
                watch.run()
                observed.append(json.loads(self.state.read_text())['state'])
        self.assertEqual(observed, ['pending', 'degraded', 'degraded', 'healthy', 'healthy'])
        self.assertEqual(len(self.notifications), 2)
        self.assertIn('degraded', self.notifications[0])
        self.assertIn('healthy again', self.notifications[1])
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)

    def test_bad_saved_failure_count_recovers(self):
        self.state.parent.mkdir(parents=True)
        self.state.write_text(json.dumps({'failures': 'broken', 'state': 'pending'}))
        with patch.object(watch, 'check', return_value=['shim_unreachable']):
            watch.run()
        self.assertEqual(json.loads(self.state.read_text())['failures'], 1)


if __name__ == '__main__':
    unittest.main()
