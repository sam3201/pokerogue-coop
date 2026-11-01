"""Cross-UID AF_UNIX credential gateway test. Disposable CI/root-only fixture.

Never provisions production identities, touches the real relay, or stores keys.
A mocked private backend is used here; separate tests cover the real Node broker.
"""
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

BASE = Path(__file__).resolve().parent
SOURCE = BASE / "private_relay_peer_gateway_v1.py"
PINNED = "d3e759b66fe43bee740a8a774cd22e5bf8a41fbc284effd454678ca41b03c3d9"

RELAY_UID, CAPTURE_UID, STRANGER_UID = 62530, 62531, 62532
RELAY_GID, CAPTURE_GID, SHARED_GID = 62530, 62531, 62533

BACKEND = r"""
import json, os, socket, sys
p = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(p)
os.chmod(p, 0o600)
s.listen(5)
while True:
    conn, _ = s.accept()
    with conn:
        conn.settimeout(2)
        received = bytearray()
        while b"\n" not in received:
            part = conn.recv(1024)
            if not part:
                break
            received.extend(part)
        if not received: continue
        msg = json.loads(received[:-1])
        if msg["op"] == "challenge":
            response = {"ok":True,"challenge":"a"*64,"expiresAt":1730000005000}
        else:
            response = {"ok":True,"private":"FORBIDDEN_BACKEND_FIELD"}
        conn.sendall(json.dumps(response,separators=(",",":")).encode()+b"\n")
"""

GATEWAY = r"""
import importlib.util, os, signal, sys
location = sys.argv[1]
spec = importlib.util.spec_from_file_location("_review_relay_gateway", location)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
gateway = module.RelayPeerGateway(
    gateway_path=sys.argv[2], backend_path=sys.argv[3],
    capture_uid=int(sys.argv[4]), ipc_gid=int(sys.argv[5])
)
def terminate(_sig,_frame): gateway.close()
signal.signal(signal.SIGTERM,terminate)
signal.signal(signal.SIGINT,terminate)
try:
    gateway.start()
    gateway.serve()
finally:
    gateway.close()
"""

CLIENT = r"""
import json, socket, sys
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(2)
try:
    sock.connect(sys.argv[1])
    sock.sendall(sys.stdin.buffer.read())
    chunks = bytearray()
    while b"\n" not in chunks:
        part = sock.recv(1024)
        if not part: break
        chunks.extend(part)
    print(chunks.decode().strip() or "null")
except OSError as exc:
    print(json.dumps({"error":type(exc).__name__}))
finally:
    sock.close()
"""


def drop(uid, gid, groups=()):
    def assign():
        os.setgroups(list(groups))
        os.setgid(gid)
        os.setuid(uid)
    return assign


def remote_request(path, data, uid, gid, groups):
    result = subprocess.run(
        [sys.executable, "-I", "-c", CLIENT, str(path)],
        text=True, input=json.dumps(data, separators=(",",":")) + "\n",
        capture_output=True, timeout=5, check=False,
        preexec_fn=drop(uid, gid, groups))
    if result.returncode:
        raise AssertionError("socket client failed " + result.stderr[-350:])
    return json.loads(result.stdout)


def wait_socket(path, proc):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if path.is_socket(): return
        if proc.poll() is not None:
            stdout, stderr = proc.communicate(timeout=2)
            raise AssertionError("peer process terminated: " + stdout + stderr)
        time.sleep(.03)
    raise AssertionError("AF_UNIX fixture socket timeout: " + str(path))


class DifferentUidGatewayProof(unittest.TestCase):
    def test_capture_peer_only_and_backend_private(self):
        if os.geteuid() != 0:
            self.fail("Only use as root in a disposable CI runner")
        for uid in (RELAY_UID, CAPTURE_UID, STRANGER_UID):
            try: pwd.getpwuid(uid)
            except KeyError: pass
            else: self.fail("Reserved test UID already exists " + str(uid))
        self.assertEqual(hashlib.sha256(SOURCE.read_bytes()).hexdigest(), PINNED)

        with tempfile.TemporaryDirectory(prefix="sam-relay-different-uid-") as temp:
            root = Path(temp)
            os.chmod(root, 0o755)
            code = root / "trusted-code"
            code.mkdir(mode=0o755)
            module = code / SOURCE.name
            shutil.copyfile(SOURCE, module)
            os.chmod(module, 0o644)
            self.assertEqual(module.stat().st_uid, 0)
            private = root / "private"
            shared = root / "capture"
            private.mkdir(mode=0o700)
            shared.mkdir(mode=0o750)
            for path, mode in ((private,0o700),(shared,0o750)):
                os.chown(path, RELAY_UID, SHARED_GID)
                os.chmod(path, mode)

            backend_path = private / "owner-grants.sock"
            gateway_path = shared / "capture-owner-gateway.sock"
            backend = subprocess.Popen(
                [sys.executable, "-I", "-c", BACKEND, str(backend_path)],
                preexec_fn=drop(RELAY_UID, SHARED_GID),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            gateway = None
            try:
                wait_socket(backend_path, backend)
                self.assertEqual(backend_path.stat().st_mode & 0o777, 0o600)
                gateway = subprocess.Popen(
                    [sys.executable, "-I", "-c", GATEWAY,
                     str(module), str(gateway_path), str(backend_path),
                     str(CAPTURE_UID), str(SHARED_GID)],
                    preexec_fn=drop(RELAY_UID, SHARED_GID),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                wait_socket(gateway_path, gateway)
                self.assertEqual(gateway_path.stat().st_mode & 0o777, 0o660)
                self.assertEqual(gateway_path.stat().st_uid, RELAY_UID)
                self.assertEqual(gateway_path.stat().st_gid, SHARED_GID)

                request={"op":"challenge","roomHandle":"ABC234",
                         "hostTokenDigest":"a"*64}
                self.assertEqual(
                    remote_request(gateway_path,request,STRANGER_UID,CAPTURE_GID,[SHARED_GID]),
                    {"ok":False},
                    "A socket-group member with wrong UID must be refused")
                self.assertEqual(
                    remote_request(backend_path,request,CAPTURE_UID,CAPTURE_GID,[SHARED_GID]),
                    {"error":"PermissionError"},
                    "Capture UID must not read private backend directly")
                self.assertEqual(
                    remote_request(gateway_path,request,CAPTURE_UID,CAPTURE_GID,[SHARED_GID]),
                    {"ok":True,"challenge":"a"*64,"expiresAt":1730000005000})
                self.assertEqual(
                    remote_request(gateway_path,{"op":"debug"},CAPTURE_UID,CAPTURE_GID,[SHARED_GID]),
                    {"ok":False})
                self.assertIsNone(
                    remote_request(gateway_path,{"op":"authorize","grant":{}},
                                   CAPTURE_UID,CAPTURE_GID,[SHARED_GID]),
                    "Gateway must fail closed on unexpected backend fields")
            finally:
                for proc in (gateway,backend):
                    if proc is None: continue
                    if proc.poll() is None: proc.terminate()
                    try: proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=3)
                    proc.communicate(timeout=2)


if __name__ == "__main__":
    unittest.main()
