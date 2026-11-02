import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from verify_signer_install_v1 import (
    MANIFEST, MODULES, SCHEMA, verify_install_tree
)


class TrustedSignerDeployment(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sam-signer-install-audit-")
        self.anchor = Path(self.temp.name)
        self.root = self.anchor / "trusted" / "signer"
        self.root.mkdir(parents=True, mode=0o700)
        (self.anchor / "trusted").chmod(0o700)
        self.root.chmod(0o700)
        self.uid = os.getuid()
        source = Path(__file__).parent
        self.hashes = {}
        for name in MODULES:
            data = (source / name).read_bytes()
            p = self.root / name
            p.write_bytes(data)
            p.chmod(0o644)
            self.hashes[name] = hashlib.sha256(data).hexdigest()
        self.manifest = self.root / MANIFEST
        self.write_manifest()

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self, **overrides):
        value = {"schema": SCHEMA, "files": self.hashes.copy()}
        value.update(overrides)
        self.manifest.write_text(json.dumps(value, sort_keys=True))
        self.manifest.chmod(0o644)

    def audit(self):
        return verify_install_tree(str(self.root),
                                   expected_uid=self.uid,
                                   anchor=str(self.anchor))

    def test_01_unmodified_mode_private_tree_and_checksums_accepted(self):
        self.assertTrue(self.audit())

    def test_02_tampered_python_file_rejected(self):
        path = self.root / MODULES[0]
        with path.open("ab") as f:
            f.write(b"\n# unexpected injected code")
        with self.assertRaisesRegex(PermissionError, "checksum mismatch"):
            self.audit()

    def test_03_group_or_world_writable_install_parent_rejected(self):
        for mode in (0o770, 0o777):
            (self.anchor / "trusted").chmod(mode)
            with self.assertRaisesRegex(PermissionError, "unsafe ownership"):
                self.audit()
        (self.anchor / "trusted").chmod(0o700)

    def test_04_group_writable_executable_rejected(self):
        path = self.root / MODULES[0]
        path.chmod(0o664)
        with self.assertRaisesRegex(PermissionError, "unsafe ownership"):
            self.audit()

    def test_05_symlinked_python_module_rejected(self):
        path = self.root / MODULES[0]
        path.rename(self.root / "other.py")
        path.symlink_to("other.py")
        with self.assertRaises(PermissionError):
            self.audit()

    def test_06_hardlinked_python_module_rejected(self):
        (self.root / "alias.py").hardlink_to(self.root / MODULES[0])
        with self.assertRaises(PermissionError):
            self.audit()

    def test_07_symlinked_install_directory_rejected(self):
        renamed = self.anchor / "trusted" / "real-signer"
        self.root.rename(renamed)
        self.root.symlink_to("real-signer", target_is_directory=True)
        with self.assertRaises(PermissionError):
            self.audit()

    def test_08_untrusted_manifest_schema_or_unexpected_files_rejected(self):
        for overrides in (
            {"schema": "not-a-signer-manifest"},
            {"files": {"unexpected.py": "f"*64}},
            {"files": {**self.hashes, "other.py": "f"*64}},
        ):
            self.write_manifest(**overrides)
            with self.assertRaises(ValueError):
                self.audit()

    def test_09_untrusted_manifest_file_permissions_rejected(self):
        self.manifest.chmod(0o666)
        with self.assertRaises(PermissionError):
            self.audit()

    def test_10_wrong_uid_is_rejected(self):
        with self.assertRaises(PermissionError):
            verify_install_tree(str(self.root), expected_uid=self.uid + 1,
                                anchor=str(self.anchor))

    def test_11_production_cli_defaults_only_to_root_path_and_uid(self):
        source = Path(__file__).parent / "verify_signer_install_v1.py"
        body = source.read_text()
        self.assertIn('INSTALL_DIR = "/usr/local/libexec/sam-agi/owner-signer"', body)
        self.assertIn('verify_install_tree(INSTALL_DIR, expected_uid=0, anchor="/")', body)

    def test_12_systemd_never_invokes_user_writable_repository_code(self):
        unit = (Path(__file__).parent /
                "sam-coop-owner-signer.service.template").read_text()
        commands = [line for line in unit.splitlines()
                    if line.startswith("ExecStart")]
        self.assertEqual(len(commands), 2)
        self.assertTrue(all("/usr/bin/python3 -I " in line for line in commands))
        self.assertTrue(all("/usr/local/libexec/sam-agi/owner-signer/" in line
                            for line in commands))
        self.assertTrue(all("/srv/sam/" not in line and
                            "/home/sam3201" not in line for line in commands))
        self.assertIn("NoNewPrivileges=true", unit)
        self.assertIn("User=sam-coop-signer", unit)
        self.assertNotIn("\n[Install]\n", unit)


if __name__ == "__main__":
    unittest.main()
