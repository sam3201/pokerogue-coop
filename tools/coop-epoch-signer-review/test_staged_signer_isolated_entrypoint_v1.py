"""Regression tests for Python -I signer startup in the UNTRUSTED review bundle.

Never installs keys, starts a service, or invokes the privileged signer.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

STAGE = Path(__file__).resolve().parent / "signer_install_review_v1" / "code"
ENTRY = STAGE / "run_private_owner_signer_service_v1.py"


class StagedIsolatedEntrypoint(unittest.TestCase):
    def test_01_manifest_matches_all_staged_bytes(self):
        manifest = json.loads((STAGE / "signer-code-manifest.json").read_text())
        self.assertEqual(manifest["schema"], "sam.coop.signer-code-manifest.v1")
        self.assertEqual(set(manifest["files"]), {
            "private_owner_signer_service_v1.py",
            "run_private_owner_signer_service_v1.py",
            "verify_signer_install_v1.py",
        })
        for name, expected in manifest["files"].items():
            self.assertEqual(hashlib.sha256((STAGE / name).read_bytes()).hexdigest(), expected)

    def _invoke(self, working_dir, pythonpath):
        # Deliberately provide no signer configuration or production keys.
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(working_dir),
            "PYTHONPATH": str(pythonpath),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        return subprocess.run(
            ["/usr/bin/python3", "-I", str(ENTRY)],
            cwd=working_dir, env=env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=8, check=False,
        )

    def test_02_isolated_import_reaches_configuration_boundary(self):
        with tempfile.TemporaryDirectory(prefix="sam-signer-import-") as tmp:
            result = self._invoke(tmp, tmp)
            self.assertNotEqual(result.returncode, 0)
            output = result.stdout + result.stderr
            self.assertIn("Required signer configuration missing: SAM_SIGNER_KEY_PATH", output)
            self.assertNotIn("ModuleNotFoundError", output)

    def test_03_cwd_and_pythonpath_module_hijacks_ignored(self):
        with tempfile.TemporaryDirectory(prefix="sam-signer-hijack-") as tmp:
            hostile = Path(tmp)
            (hostile / "private_owner_signer_service_v1.py").write_text(
                'raise RuntimeError("HIJACKED_SIBLING_MODULE")\n')
            (hostile / "sitecustomize.py").write_text(
                'raise RuntimeError("HIJACKED_SITE_CUSTOMIZE")\n')
            result = self._invoke(hostile, hostile)
            output = result.stdout + result.stderr
            self.assertIn("Required signer configuration missing: SAM_SIGNER_KEY_PATH", output)
            self.assertNotIn("HIJACKED_", output)


if __name__ == "__main__":
    unittest.main()
