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


    def test_08_relay_directory_requires_correct_uid_gid_and_mode(self):
        from preflight_owner_isolation_v1 import group_directory
        with tempfile.TemporaryDirectory(prefix="sam-gateway-group-") as d:
            path = Path(d) / "relay"
            path.mkdir(mode=0o700)
            path.chmod(0o750)
            self.assertTrue(group_directory(
                path, os.getuid(), os.getgid(), 0o750))
            self.assertFalse(group_directory(
                path, os.getuid(), os.getgid()+1, 0o750))
            path.chmod(0o770)
            self.assertFalse(group_directory(
                path, os.getuid(), os.getgid(), 0o750))

    def test_09_dedicated_relay_must_not_reuse_capture_uid(self):
        from types import SimpleNamespace as P
        from unittest.mock import patch
        import preflight_owner_isolation_v1 as preflight
        users = {
            "sam-coop-signer": P(pw_uid=301, pw_gid=41, pw_name="sam-coop-signer"),
            "sam-coop-capture": P(pw_uid=302, pw_gid=42, pw_name="sam-coop-capture"),
            "sam-coop-relay": P(pw_uid=303, pw_gid=42, pw_name="sam-coop-relay"),
            "sam3201": P(pw_uid=1000, pw_gid=1000, pw_name="sam3201"),
        }
        group = P(gr_gid=42, gr_mem=[])
        with (patch.object(preflight.pwd, "getpwnam", side_effect=users.__getitem__),
              patch.object(preflight.grp, "getgrnam", return_value=group)):
            self.assertTrue(preflight.relay_identity_gate()[0])
            users["sam-coop-relay"] = P(
                pw_uid=302, pw_gid=42, pw_name="sam-coop-relay")
            self.assertFalse(preflight.relay_identity_gate()[0])


    def test_10_root_controlled_ancestors_rejects_writable_parent(self):
        import stat
        from types import SimpleNamespace as S
        from unittest.mock import patch
        import preflight_owner_isolation_v1 as preflight

        safe = S(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
        unsafe = S(st_uid=0, st_mode=stat.S_IFDIR | 0o775)
        path = "/etc/sam-agi/owner-signer.env"
        with patch.object(preflight.os, "lstat", return_value=safe):
            self.assertTrue(preflight.root_controlled_ancestors(path))
        with patch.object(
            preflight.os, "lstat",
            side_effect=lambda p: unsafe if str(p) == "/etc/sam-agi" else safe
        ):
            self.assertFalse(preflight.root_controlled_ancestors(path))

    def test_11_root_controlled_ancestors_rejects_symlinked_parent(self):
        import stat
        from types import SimpleNamespace as S
        from unittest.mock import patch
        import preflight_owner_isolation_v1 as preflight

        safe = S(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
        link = S(st_uid=0, st_mode=stat.S_IFLNK | 0o777)
        path = "/etc/systemd/system/sam-coop-owner-signer.service"
        with patch.object(
            preflight.os, "lstat",
            side_effect=lambda p: link if str(p) == "/etc/systemd" else safe
        ):
            self.assertFalse(preflight.root_controlled_ancestors(path))
        self.assertFalse(preflight.root_controlled_ancestors("relative/config"))



if __name__ == "__main__":
    unittest.main()
