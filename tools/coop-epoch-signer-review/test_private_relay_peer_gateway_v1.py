"""Disposable, same-UID lab coverage for peer-credential gateway.

No production identities, keys, relay, or service are touched.
Separate-UID acceptance is explicitly NOT proven by this fixture.
"""
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from private_relay_peer_gateway_v1 import RelayPeerGateway, valid_request


class GatewayFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sam-relay-uid-lab-")
        self.root = Path(self.temp.name)
        self.front_dir = self.root / "external"
        self.back_dir = self.root / "internal"
        self.front_dir.mkdir()
        self.back_dir.mkdir()
        self.front_dir.chmod(0o750)
        self.back_dir.chmod(0o700)
        self.front = str(self.front_dir / "capture-owner-gateway.sock")
        self.back = str(self.back_dir / "owner-grants.sock")
        self.backend = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.backend.bind(self.back)
        os.chmod(self.back, 0o600)
        self.backend.listen(3)
        self.backend.settimeout(0.2)
        self.stopping = threading.Event()
        self.received = []
        self.reply = lambda request: {"ok": True, "challenge": "a"*64,
                                      "expiresAt": 1730000005000}
        self.backend_thread = threading.Thread(target=self.backend_loop, daemon=True)
        self.backend_thread.start()
        self.gateway = None
        self.gateway_thread = None

    def backend_loop(self):
        while not self.stopping.is_set():
            try:
                client, _ = self.backend.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with client:
                client.settimeout(2)
                raw = bytearray()
                try:
                    while b"\n" not in raw:
                        chunk = client.recv(1024)
                        if not chunk:
                            break
                        raw.extend(chunk)
                    if not raw:
                        continue
                    request = json.loads(raw[:-1])
                    self.received.append(request)
                    response = self.reply(request)
                    client.sendall(json.dumps(response).encode() + b"\n")
                except (OSError, ValueError):
                    continue

    def tearDown(self):
        if self.gateway:
            self.gateway.close()
        if self.gateway_thread:
            self.gateway_thread.join(timeout=2)
            self.assertFalse(self.gateway_thread.is_alive())
        self.stopping.set()
        self.backend.close()
        self.backend_thread.join(timeout=2)
        self.assertFalse(self.backend_thread.is_alive())
        self.temp.cleanup()

    def start(self, uid=None, test_same_uid=True):
        self.gateway = RelayPeerGateway(
            gateway_path=self.front,
            backend_path=self.back,
            capture_uid=os.getuid() if uid is None else uid,
            ipc_gid=os.getgid(),
            test_same_uid=test_same_uid,
        )
        self.gateway.start()
        self.gateway_thread = threading.Thread(
            target=self.gateway.serve, daemon=True)
        self.gateway_thread.start()

    def request(self, request):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(self.front)
            client.sendall((json.dumps(request) + "\n").encode())
            raw = bytearray()
            while b"\n" not in raw:
                part = client.recv(1024)
                if not part:
                    break
                raw.extend(part)
            return json.loads(raw) if raw else None

    def challenge(self):
        return {"op": "challenge", "roomHandle": "ABC234",
                "hostTokenDigest": "a"*64}

    def test_01_real_socket_forwards_challenge_same_uid_fixture(self):
        self.start()
        result = self.request(self.challenge())
        self.assertTrue(result["ok"])
        self.assertEqual(result["challenge"], "a"*64)
        self.assertEqual(self.gateway.forwarded, 1)
        self.assertEqual(len(self.received), 1)
        self.assertEqual(os.stat(self.front).st_mode & 0o777, 0o660)

    def test_02_production_refuses_same_uid_even_with_group(self):
        with self.assertRaisesRegex(PermissionError, "UIDs must differ"):
            self.start(test_same_uid=False)

    def test_03_wrong_peer_uid_rejected_before_backend(self):
        self.start(uid=os.getuid()+1000, test_same_uid=False)
        self.assertEqual(self.request(self.challenge()), {"ok": False})
        self.assertEqual(self.received, [])
        self.assertEqual(self.gateway.forwarded, 0)
        self.assertEqual(self.gateway.denied, 1)

    def test_04_malformed_operation_rejected_without_forward(self):
        self.start()
        self.assertEqual(self.request({"op": "debug"}), {"ok": False})
        self.assertEqual(self.request({
            **self.challenge(), "leak": "private"}), {"ok": False})
        self.assertEqual(self.received, [])

    def test_05_authorize_uses_same_credential_check(self):
        self.reply = lambda req: {"ok": True}
        self.start()
        result = self.request({"op": "authorize", "grant": {"x": 1}})
        self.assertEqual(result, {"ok": True})
        self.assertEqual(self.gateway.forwarded, 1)

    def test_06_backend_response_private_fields_not_forwarded(self):
        self.reply = lambda req: {"ok": True, "secret": "should-not-leak"}
        self.start()
        self.assertIsNone(self.request(self.challenge()))
        self.assertEqual(self.gateway.forwarded, 0)

    def test_07_unsafe_external_dir_rejected(self):
        self.front_dir.chmod(0o770)
        with self.assertRaisesRegex(PermissionError, "Unsafe relay IPC directory"):
            self.start()

    def test_08_backend_mode_change_blocks_forward(self):
        self.start()
        os.chmod(self.back, 0o666)
        self.assertIsNone(self.request(self.challenge()))
        self.assertEqual(self.received, [])

    def test_09_preexisting_gateway_path_refused(self):
        Path(self.front).write_text("do not replace")
        self.gateway = RelayPeerGateway(
            gateway_path=self.front, backend_path=self.back,
            capture_uid=os.getuid(), ipc_gid=os.getgid(), test_same_uid=True)
        with self.assertRaises(FileExistsError):
            self.gateway.start()
        self.assertEqual(Path(self.front).read_text(), "do not replace")

    def test_10_request_schema_exactness(self):
        self.assertTrue(valid_request(self.challenge()))
        self.assertFalse(valid_request({"op": "challenge"}))
        self.assertFalse(valid_request({"op": "whoami", "payload": {}}))
        self.assertFalse(valid_request({"op": "authorize", "grant": {},
                                        "private": True}))


if __name__ == "__main__":
    unittest.main()
