"""Disposable Linux distinct-UID integration proof for the SAM one-run signer.

Requires root only in an isolated CI runner. Does not create system accounts,
install a production key, change systemd, or access the real co-op relay.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parent
RUN_ID = "7c768a8e-2f2e-4b14-8900-991c1e9eaaaa"
SIGNER_UID, CAPTURE_UID, OUTSIDER_UID = 62520, 62521, 62522
SIGNER_GID, CAPTURE_GID, IPC_GID = 62520, 62521, 62523

CLIENT_CODE = r"""
import json, socket, sys
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
    sock.settimeout(2)
    sock.connect(sys.argv[1])
    sock.sendall(sys.stdin.buffer.read())
    chunks = bytearray()
    while b"\n" not in chunks:
        part = sock.recv(1024)
        if not part:
            break
        chunks.extend(part)
        if len(chunks) > 8192:
            raise RuntimeError("unbounded response")
    sys.stdout.write(chunks.decode())
"""


def _drop(uid, primary_gid, supplementary):
    def set_ids():
        os.setgroups(supplementary)
        os.setgid(primary_gid)
        os.setuid(uid)
    return set_ids


def _send(socket_path, req, uid, gid, groups):
    result = subprocess.run(
        [sys.executable, "-I", "-c", CLIENT_CODE, str(socket_path)],
        input=json.dumps(req, separators=(",", ":")) + "\n",
        text=True, capture_output=True, timeout=5,
        preexec_fn=_drop(uid, gid, groups),
        check=False,
    )
    if result.returncode:
        raise AssertionError(
            "isolated peer failed: " + result.stderr[-400:]
        )
    return json.loads(result.stdout)


class DistinctUnixPrincipals(unittest.TestCase):
    def test_private_signer_rejects_wrong_uid_and_signs_once(self):
        if os.geteuid() != 0:
            self.fail("must run as root in a disposable CI runner")
        for uid in (SIGNER_UID, CAPTURE_UID, OUTSIDER_UID):
            try:
                pwd.getpwuid(uid)
            except KeyError:
                pass
            else:
                self.fail("test numeric UID already exists: " + str(uid))

        with tempfile.TemporaryDirectory(prefix="coop-uid-fixture-") as tmp:
            base = Path(tmp)
            # TemporaryDirectory defaults to 0700 root. Allow only traversal
            # of the parent; key material remains in a private signer dir.
            os.chmod(base, 0o755)
            # The CI checkout is not accessible to a synthetic non-login
            # Unix UID. Copy only hash-pinned release code into a temporary
            # root-owned, nonwritable executable directory.
            trusted = base / "root-managed-code"
            trusted.mkdir(mode=0o755)
            source = ROOT / "signer_install_review_v1" / "code"
            manifest = json.loads((source / "signer-code-manifest.json").read_text())
            self.assertEqual(manifest["schema"], "sam.coop.signer-code-manifest.v1")
            for name in (
                "private_owner_signer_service_v1.py",
                "run_private_owner_signer_service_v1.py",
                "verify_signer_install_v1.py",
            ):
                self.assertEqual(
                    hashlib.sha256((source / name).read_bytes()).hexdigest(),
                    manifest["files"][name],
                )
                shutil.copyfile(source / name, trusted / name)
                os.chmod(trusted / name, 0o644)
                self.assertEqual((trusted / name).stat().st_uid, 0)
            runner = trusted / "run_private_owner_signer_service_v1.py"
            private = base / "private"
            runtime = base / "runtime"
            private.mkdir(mode=0o700)
            runtime.mkdir(mode=0o750)
            os.chown(private, SIGNER_UID, SIGNER_GID)
            os.chown(runtime, SIGNER_UID, IPC_GID)
            os.chmod(private, 0o700)
            os.chmod(runtime, 0o750)

            secret = Ed25519PrivateKey.generate()
            private_der = secret.private_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
            spki = secret.public_key().public_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            pin = hashlib.sha256(spki).hexdigest()
            key_path = private / "owner-ed25519.pk8"
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, private_der)
                os.fchown(fd, SIGNER_UID, SIGNER_GID)
            finally:
                os.close(fd)
            sock_path = runtime / "room-grant-signer.sock"
            env = os.environ.copy()
            env.update({
                "SAM_SIGNER_KEY_PATH": str(key_path),
                "SAM_SIGNER_SOCKET_PATH": str(sock_path),
                "SAM_SIGNER_PUBLIC_PIN": pin,
                "SAM_SIGNER_RUN_ID": RUN_ID,
                "SAM_SIGNER_CAPTURE_UID": str(CAPTURE_UID),
                "PYTHONDONTWRITEBYTECODE": "1",
            })

            server = subprocess.Popen(
                [sys.executable, "-I", str(runner)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                env=env, preexec_fn=_drop(SIGNER_UID, IPC_GID, []),
            )
            try:
                deadline = time.monotonic() + 6
                while not sock_path.is_socket() and time.monotonic() < deadline:
                    if server.poll() is not None:
                        out, err = server.communicate(timeout=2)
                        self.fail("signer exited: " + out + " " + err)
                    time.sleep(0.03)
                self.assertTrue(sock_path.is_socket(), "signer socket never appeared")
                self.assertEqual(sock_path.stat().st_uid, SIGNER_UID)
                self.assertEqual(sock_path.stat().st_mode & 0o777, 0o660)
                now = int(time.time() * 1000)
                payload = {
                    "schema": "sam.coop.owner-room-grant.v1",
                    "roomHandle": "ABCD23",
                    "runId": RUN_ID,
                    "challenge": "a" * 64,
                    "hostTokenDigest": "b" * 64,
                    "issuedAt": now,
                    "expiresAt": now + 4000,
                }
                request = {"op": "sign_room_grant", "payload": payload}

                # The outsider can access the IPC socket through the group,
                # but SO_PEERCRED must reject the wrong UID.
                bad = _send(sock_path, request, OUTSIDER_UID, CAPTURE_GID, [IPC_GID])
                self.assertFalse(bad["ok"])

                malformed = {
                    "op": "sign_room_grant",
                    "payload": {**payload, "runId": "8c768a8e-2f2e-4b14-8900-991c1e9eaaaa"},
                }
                wrong_run = _send(sock_path, malformed, CAPTURE_UID, CAPTURE_GID, [IPC_GID])
                self.assertFalse(wrong_run["ok"])

                approved = _send(sock_path, request, CAPTURE_UID, CAPTURE_GID, [IPC_GID])
                self.assertTrue(approved["ok"])
                grant = approved["grant"]
                self.assertEqual(grant["keyId"], pin)
                self.assertEqual(grant["payload"], payload)
                signature = base64.urlsafe_b64decode(
                    grant["signature"] + "=" * (-len(grant["signature"]) % 4)
                )
                canonical = json.dumps(
                    payload, separators=(",", ":"), ensure_ascii=False
                ).encode()
                secret.public_key().verify(signature, canonical)

                self.assertEqual(server.wait(timeout=5), 0)
                self.assertFalse(sock_path.exists(), "signer did not remove socket")
                self.assertEqual(len(signature), 64)
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=2)
                server.communicate(timeout=2)


if __name__ == "__main__":
    unittest.main()
