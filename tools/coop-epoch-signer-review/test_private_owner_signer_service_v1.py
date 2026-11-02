import base64
import hashlib
import json
import os
import socket
import stat
import tempfile
import threading
import time
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from private_owner_signer_service_v1 import (
    OwnerRoomSigner, SCHEMA, PAYLOAD_FIELDS
)

RUN = "12345678-1234-4123-8123-123456789abc"
ROOM = "ABC234"
TOKEN_DIGEST = "a" * 64


class SignerFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sam-signer-isolated-")
        os.chmod(self.temp.name, 0o700)
        self.key_path = os.path.join(self.temp.name, "owner-ed25519.pk8")
        self.socket_path = os.path.join(self.temp.name, "room-grant-signer.sock")
        self.key = Ed25519PrivateKey.generate()
        self.public_der = self.key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        )
        self.pin = hashlib.sha256(self.public_der).hexdigest()
        pem = self.key.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        )
        with open(self.key_path, "xb") as f:
            f.write(pem)
        os.chmod(self.key_path, 0o600)
        self.signer = None
        self.worker = None

    def tearDown(self):
        if self.signer:
            self.signer.close()
        if self.worker:
            self.worker.join(timeout=2)
            self.assertFalse(self.worker.is_alive())
        self.temp.cleanup()

    def create(self, **kwargs):
        self.signer = OwnerRoomSigner(
            key_path=self.key_path,
            socket_path=self.socket_path,
            expected_pin=self.pin,
            allowed_run_id=RUN,
            allowed_peer_uid=os.getuid(),
            test_allow_same_uid=True,
            **kwargs
        )
        self.signer.start()
        self.worker = threading.Thread(target=self.signer.serve, daemon=True)
        self.worker.start()
        return self.signer

    def payload(self, **kwargs):
        now = int(time.time() * 1000)
        data = dict(schema=SCHEMA, roomHandle=ROOM, runId=RUN,
                    challenge="b"*64, hostTokenDigest=TOKEN_DIGEST,
                    issuedAt=now, expiresAt=now + 3500)
        data.update(kwargs)
        self.assertEqual(tuple(data), PAYLOAD_FIELDS)
        return data

    def request(self, obj):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(3)
            sock.connect(self.socket_path)
            try:
                sock.sendall(json.dumps(obj, separators=(",", ":")).encode() + b"\n")
                data = b""
                while b"\n" not in data:
                    b = sock.recv(512)
                    if not b:
                        break
                    data += b
                return json.loads(data.decode().strip()) if data else {"ok":False}
            except (BrokenPipeError, ConnectionResetError):
                # A denied UID may be disconnected before request upload.
                return {"ok":False}

    def test_01_correct_uid_produces_interoperable_ed25519_grant(self):
        self.create()
        result = self.request({"op":"sign_room_grant","payload":self.payload()})
        self.assertTrue(result["ok"])
        grant = result["grant"]
        self.assertEqual(grant["schema"], SCHEMA)
        self.assertEqual(grant["keyId"], self.pin)
        self.assertEqual(grant["payload"]["runId"], RUN)
        signature = base64.urlsafe_b64decode(grant["signature"] + "==")
        message = json.dumps(grant["payload"], separators=(",", ":")).encode()
        self.key.public_key().verify(signature, message)
        self.assertEqual(self.signer.count, 1)
        self.assertEqual(os.stat(self.socket_path).st_mode & 0o777, 0o660)

    def test_02_one_signature_only_even_with_new_challenge(self):
        self.create()
        self.assertTrue(self.request({"op":"sign_room_grant","payload":self.payload()})["ok"])
        self.assertEqual(self.request({"op":"sign_room_grant","payload":
            self.payload(challenge="d"*64)}), {"ok":False})
        self.assertEqual(self.signer.count, 1)

    def test_03_wrong_room_run_and_schema_rejected(self):
        self.create()
        for p in (self.payload(roomHandle="A!C234"),
                  self.payload(runId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                  self.payload(schema="different"),
                  self.payload(challenge="bad"),
                  self.payload(hostTokenDigest="token")):
            self.assertEqual(self.request({"op":"sign_room_grant","payload":p}), {"ok":False})
        self.assertEqual(self.signer.count, 0)

    def test_04_expired_and_overlong_grants_rejected(self):
        self.create()
        now = int(time.time()*1000)
        for p in (self.payload(issuedAt=now-3000,expiresAt=now-1),
                  self.payload(issuedAt=now+10000,expiresAt=now+12000),
                  self.payload(issuedAt=now,expiresAt=now+40000)):
            self.assertEqual(self.request({"op":"sign_room_grant","payload":p}), {"ok":False})

    def test_05_unknown_op_and_extra_metadata_rejected(self):
        self.create()
        p = self.payload()
        self.assertEqual(self.request({"op":"sign_any","payload":p}), {"ok":False})
        self.assertEqual(self.request({"op":"sign_room_grant","payload":p,
            "key_export":True}), {"ok":False})
        p["privateToken"] = "do-not-serialize"
        self.assertEqual(self.request({"op":"sign_room_grant","payload":p}), {"ok":False})

    def test_06_uid_mismatch_is_rejected(self):
        self.signer = OwnerRoomSigner(
            key_path=self.key_path,socket_path=self.socket_path,
            expected_pin=self.pin,allowed_run_id=RUN,
            allowed_peer_uid=os.getuid()+1000
        )
        self.signer.start()
        self.worker=threading.Thread(target=self.signer.serve,daemon=True)
        self.worker.start()
        self.assertEqual(self.request({"op":"sign_room_grant","payload":self.payload()}),
                         {"ok":False})
        self.assertEqual(self.signer.count,0)

    def test_07_same_uid_refused_without_explicit_test_flag(self):
        with self.assertRaises(PermissionError):
            OwnerRoomSigner(key_path=self.key_path,socket_path=self.socket_path,
                expected_pin=self.pin,allowed_run_id=RUN,allowed_peer_uid=os.getuid())

    def test_08_private_key_wrong_pin_rejected(self):
        with self.assertRaisesRegex(ValueError,"pin mismatch"):
            OwnerRoomSigner(key_path=self.key_path,socket_path=self.socket_path,
                expected_pin="e"*64,allowed_run_id=RUN,
                allowed_peer_uid=os.getuid()+1)

    def test_09_group_readable_key_rejected(self):
        os.chmod(self.key_path, 0o644)
        with self.assertRaisesRegex(ValueError,"not private"):
            OwnerRoomSigner(key_path=self.key_path,socket_path=self.socket_path,
                expected_pin=self.pin,allowed_run_id=RUN,
                allowed_peer_uid=os.getuid()+1)

    def test_10_socket_already_exists_is_not_replaced(self):
        with open(self.socket_path,"w") as f: f.write("other user data")
        self.signer=OwnerRoomSigner(key_path=self.key_path,socket_path=self.socket_path,
            expected_pin=self.pin,allowed_run_id=RUN,allowed_peer_uid=os.getuid()+1)
        with self.assertRaises(FileExistsError): self.signer.start()
        self.signer.close()
        with open(self.socket_path) as f:
            self.assertEqual(f.read(),"other user data")

    def test_11_shutdown_cleans_only_own_socket(self):
        self.create()
        self.assertTrue(os.path.exists(self.socket_path))
        self.signer.close()
        self.assertFalse(os.path.exists(self.socket_path))

    def test_12_no_signing_data_released_for_unauthorized_uid(self):
        self.signer=OwnerRoomSigner(key_path=self.key_path,socket_path=self.socket_path,
            expected_pin=self.pin,allowed_run_id=RUN,
            allowed_peer_uid=os.getuid()+1)
        self.signer.start()
        self.worker=threading.Thread(target=self.signer.serve,daemon=True)
        self.worker.start()
        r=self.request({"op":"sign_room_grant","payload":self.payload()})
        self.assertEqual(r,{"ok":False})
        self.assertNotIn("grant",r)


    def test_13_production_one_signature_then_event_loop_exits(self):
        self.signer = OwnerRoomSigner(
            key_path=self.key_path, socket_path=self.socket_path,
            expected_pin=self.pin, allowed_run_id=RUN,
            allowed_peer_uid=os.getuid(), test_allow_same_uid=True,
            stop_when_signed=True
        )
        self.signer.start()
        self.worker = threading.Thread(target=self.signer.serve, daemon=True)
        self.worker.start()
        response=self.request({"op":"sign_room_grant","payload":self.payload()})
        self.assertTrue(response["ok"])
        self.worker.join(timeout=2)
        self.assertFalse(self.worker.is_alive())
        self.assertEqual(self.signer.count,1)

    def test_14_production_launcher_never_enables_same_uid_override(self):
        from pathlib import Path
        root=Path(__file__).parent
        cli=(root/"run_private_owner_signer_service_v1.py").read_text()
        template=(root/"sam-coop-owner-signer.service.template").read_text()
        self.assertIn("test_allow_same_uid=False",cli)
        self.assertIn("stop_when_signed=True",cli)
        self.assertIn("User=sam-coop-signer",template)
        self.assertIn("Group=sam-coop-ipc",template)
        self.assertIn("RestrictAddressFamilies=AF_UNIX",template)
        self.assertNotIn("\n[Install]\n",template)

    def test_15_group_access_to_key_directory_rejected(self):
        for mode in (0o750, 0o770):
            with self.subTest(mode=oct(mode)):
                os.chmod(self.temp.name, mode)
                try:
                    with self.assertRaisesRegex(ValueError, "signer directory is not private"):
                        OwnerRoomSigner(
                            key_path=self.key_path, socket_path=self.socket_path,
                            expected_pin=self.pin, allowed_run_id=RUN,
                            allowed_peer_uid=os.getuid()+1,
                        )
                finally:
                    os.chmod(self.temp.name, 0o700)

    def test_16_group_writable_socket_directory_rejected(self):
        parent = os.path.join(self.temp.name, "ipc")
        os.mkdir(parent, 0o700)
        os.chmod(parent, 0o770)
        with self.assertRaisesRegex(PermissionError, "IPC directory unsafe"):
            OwnerRoomSigner(
                key_path=self.key_path,
                socket_path=os.path.join(parent, "room-grant-signer.sock"),
                expected_pin=self.pin, allowed_run_id=RUN,
                allowed_peer_uid=os.getuid()+1,
            )

    def test_17_group_traversable_socket_directory_is_supported(self):
        parent = os.path.join(self.temp.name, "ipc")
        os.mkdir(parent, 0o700)
        os.chmod(parent, 0o750)
        instance = OwnerRoomSigner(
            key_path=self.key_path,
            socket_path=os.path.join(parent, "room-grant-signer.sock"),
            expected_pin=self.pin, allowed_run_id=RUN,
            allowed_peer_uid=os.getuid()+1,
        )
        instance.close()

if __name__ == "__main__":
    unittest.main(verbosity=2)
