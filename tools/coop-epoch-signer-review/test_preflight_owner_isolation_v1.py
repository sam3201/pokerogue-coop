"""Independent contract tests; do not provision users, keys or services."""
import os
from pathlib import Path
import tempfile
import unittest

from preflight_owner_isolation_v1 import CHECKS, assess, facts, metadata


class OwnerIsolationPreflightTests(unittest.TestCase):
    def test_01_empty_snapshot_refused(self):
        with self.assertRaises(ValueError):
            assess({})

    def test_02_unknown_snapshot_fields_refused(self):
        snapshot = dict.fromkeys(CHECKS, True)
        snapshot["untrustedOverride"] = True
        with self.assertRaises(ValueError):
            assess(snapshot)

    def test_03_nonboolean_snapshot_fields_refused(self):
        snapshot = dict.fromkeys(CHECKS, True)
        snapshot["distinct_os_identities"] = 1
        with self.assertRaises(ValueError):
            assess(snapshot)

    def test_04_no_prerequisites_report_exact_blockers(self):
        report = assess(dict.fromkeys(CHECKS, False))
        self.assertEqual(report["blocked_checks"], list(CHECKS))
        self.assertFalse(report["static_prerequisites_met"])
        self.assertFalse(report["production_scene_eligible"])

    def test_05_static_checks_cannot_claim_trusted_epoch(self):
        report = assess(dict.fromkeys(CHECKS, True))
        self.assertTrue(report["static_prerequisites_met"])
        self.assertFalse(report["capture_worker_authenticated"])
        self.assertFalse(report["relay_integration_proven"])
        self.assertFalse(report["scene_epoch_attested"])
        self.assertFalse(report["production_scene_eligible"])

    def test_06_read_only_metadata_check(self):
        with tempfile.TemporaryDirectory(prefix="sam-provision-preflight-") as d:
            root = Path(d)
            key = root / "test.pk8"
            key.write_bytes(b"test")
            os.chmod(key, 0o600)
            self.assertTrue(metadata(key, os.getuid(), 0o600))
            self.assertFalse(metadata(key, os.getuid(), 0o644))
            os.chmod(key, 0o644)
            self.assertFalse(metadata(key, os.getuid(), 0o600))
            link = root / "link.pk8"
            link.symlink_to(key)
            self.assertFalse(metadata(link, os.getuid(), 0o644))

    def test_07_live_preflight_fails_closed_without_evidence(self):
        report = assess(facts())
        self.assertEqual(report["schema"], "sam.coop.owner-isolation-preflight.v1")
        self.assertIsInstance(report["blocked_checks"], list)
        self.assertFalse(report["production_scene_eligible"])


if __name__ == "__main__":
    unittest.main()
