"""Disposable four-UID Linux integration for the real relay, gateway, and signer.

Only for a fresh root-capable CI host. Uses random temporary Ed25519 key,
synthetic room and checkpoint; never provisions system identities or touches
the live capture writer, networking, game assets, or production service.
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

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "signer_install_review_v1" / "code"
RUN_ID = "7c768a8e-2f2e-4b14-8900-991c1e9eaaaa"
ROOM = "ABC234"
HOST_TOKEN = "1a" * 16
RELAY_UID, CAPTURE_UID, SIGNER_UID, STRANGER_UID = 62550, 62551, 62552, 62553
IPC_GID, CAPTURE_GID, SIGNER_GID, STRANGER_GID = 62554, 62551, 62552, 62553
NODE_FILES = (
    "relay_observed_checkpoint_ledger_v1.mjs",
    "relay_room_checkpoint_adapter_v1.mjs",
    "owner_room_grant_broker_v1.mjs",
    "owner_room_grant_ipc_v1.mjs",
    "capture_owner_room_enrollment_v1.mjs",
    "cross_uid_relay_backend_fixture_v1.mjs",
    "cross_uid_capture_client_fixture_v1.mjs",
)
PINNED = {
    "private_owner_signer_service_v1.py":
      "6f81e08179be899f9ba8eeb7febc3d8c40208105af483c28043d32148c594587",
    "run_private_owner_signer_service_v1.py":
      "252065ecda182c9466e048f5fb6c1efb436fd09691fd7d079712f0f85b6099f0",
    "verify_signer_install_v1.py":
      "ab772bf5a3ab12dfdaa8656cda62d8a320bde8a68e226cdddb5559fb43b8e143",
}

GATEWAY_ENTRY = r"""
import importlib.util,signal,sys
spec=importlib.util.spec_from_file_location("_sam_uid_relay_gateway",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
gateway=module.RelayPeerGateway(
    gateway_path=sys.argv[2],backend_path=sys.argv[3],
    capture_uid=int(sys.argv[4]),ipc_gid=int(sys.argv[5]))
def stop(_s,_f):gateway.close()
signal.signal(signal.SIGTERM,stop)
try:
    gateway.start()
    gateway.serve()
finally:
    gateway.close()
"""

CLIENT = r"""
import json,socket,sys
request=json.loads(sys.stdin.read())
sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
sock.settimeout(2)
try:
    sock.connect(sys.argv[1])
    sock.sendall((json.dumps(request,separators=(",",":"))+"\n").encode())
    reply=bytearray()
    while b"\n" not in reply:
        part=sock.recv(1024)
        if not part:break
        reply.extend(part)
    print(reply.decode().strip() or "null")
except OSError as e:
    print(json.dumps({"error":type(e).__name__}))
finally:
    sock.close()
"""


def _drop(uid, gid, groups=()):
    def set_user():
        os.setgroups(list(groups))
        os.setgid(gid)
        os.setuid(uid)
    return set_user


def _wait_socket(path, process, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_socket():
            return
        if process.poll() is not None:
            out, err = process.communicate(timeout=2)
            raise AssertionError("early process exit: " + out[-250:] + " " + err[-250:])
        time.sleep(.03)
    raise AssertionError("fixture socket did not start: " + path.name)


def _sock_request(path, request, uid, gid, groups, cwd):
    p = subprocess.run(
        [sys.executable, "-I", "-c", CLIENT, str(path)],
        cwd=cwd, text=True, capture_output=True,
        input=json.dumps(request), timeout=5, check=False,
        preexec_fn=_drop(uid, gid, groups))
    if p.returncode:
        raise AssertionError("synthetic IPC client error: " + p.stderr[-300:])
    return json.loads(p.stdout)


class FullFourUidPipeline(unittest.TestCase):
    def test_real_broker_gateway_signer_and_capture_are_isolated(self):
        if os.geteuid() != 0:
            self.fail("Do not run outside disposable privileged CI")
        for uid in (RELAY_UID, CAPTURE_UID, SIGNER_UID, STRANGER_UID):
            try:
                pwd.getpwuid(uid)
            except KeyError:
                pass
            else:
                self.fail("Reserved synthetic test UID already present")

        with tempfile.TemporaryDirectory(prefix="sam-multiprincipal-fixture-") as temp:
            base = Path(temp)
            os.chmod(base, 0o755)
            code = base / "trusted-code"
            code.mkdir(mode=0o755)
            self.assertEqual(json.loads(
                (SOURCE / "signer-code-manifest.json").read_text()
            ), {"schema": "sam.coop.signer-code-manifest.v1", "files": PINNED})
            for name, digest in PINNED.items():
                self.assertEqual(hashlib.sha256((SOURCE / name).read_bytes()).hexdigest(), digest)
            for name in (
                *NODE_FILES, "private_relay_peer_gateway_v1.py",
                *PINNED, "signer-code-manifest.json",
            ):
                src = SOURCE / name if name in PINNED or name == "signer-code-manifest.json" else ROOT / name
                dest = code / name
                shutil.copyfile(src, dest)
                os.chown(dest, 0, 0)
                os.chmod(dest, 0o644)
            # Validate the exact immutable install tree before starting
            # the signer as the unprivileged signer UID.
            verifier = subprocess.run(
                [sys.executable, "-I", "-c",
                 "import importlib.util,sys;"
                 "s=importlib.util.spec_from_file_location('v',sys.argv[1]);"
                 "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                 "m.verify_install_tree(sys.argv[2],expected_uid=0,anchor=sys.argv[3])",
                 str(code / "verify_signer_install_v1.py"), str(code), str(base)],
                cwd=base, capture_output=True, text=True, timeout=5)
            self.assertEqual(verifier.returncode, 0, verifier.stderr[-400:])

            relay_private = base / "relay-private"
            relay_capture = base / "relay-capture"
            signer_runtime = base / "signer-runtime"
            signer_state = base / "signer-state"
            for folder,uid,gid,mode in (
                (relay_private,RELAY_UID,IPC_GID,0o700),
                (relay_capture,RELAY_UID,IPC_GID,0o750),
                (signer_runtime,SIGNER_UID,IPC_GID,0o750),
                (signer_state,SIGNER_UID,SIGNER_GID,0o700),
            ):
                folder.mkdir(mode=mode)
                os.chown(folder,uid,gid)
                os.chmod(folder,mode)

            private = Ed25519PrivateKey.generate()
            raw = private.private_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption())
            spki = private.public_key().public_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PublicFormat.SubjectPublicKeyInfo)
            pin = hashlib.sha256(spki).hexdigest()
            key_path = signer_state / "owner-ed25519.pk8"
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd,raw)
                os.fchown(fd,SIGNER_UID,SIGNER_GID)
            finally:
                os.close(fd)
            pub_path = code / "fixture-owner-public.spki.der"
            pub_path.write_bytes(spki)
            os.chown(pub_path,0,0)
            os.chmod(pub_path,0o644)
            backend_socket = relay_private / "owner-grants.sock"
            gateway_socket = relay_capture / "capture-owner-gateway.sock"
            signer_socket = signer_runtime / "room-grant-signer.sock"

            env = dict(os.environ)
            env["SAM_UID_FIXTURE_ONLY"] = "1"
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            server_env = env.copy()
            signer_env = env.copy()
            signer_env.update({
                "SAM_SIGNER_KEY_PATH":str(key_path),
                "SAM_SIGNER_SOCKET_PATH":str(signer_socket),
                "SAM_SIGNER_PUBLIC_PIN":pin,
                "SAM_SIGNER_RUN_ID":RUN_ID,
                "SAM_SIGNER_CAPTURE_UID":str(CAPTURE_UID),
            })
            live=[]
            try:
                backend = subprocess.Popen(
                    ["node", str(code / "cross_uid_relay_backend_fixture_v1.mjs"),
                     str(backend_socket),str(pub_path),ROOM,HOST_TOKEN],
                    env=server_env,cwd=base,preexec_fn=_drop(RELAY_UID,IPC_GID),
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                live.append(backend)
                _wait_socket(backend_socket,backend)
                self.assertEqual(backend_socket.stat().st_uid,RELAY_UID)
                self.assertEqual(backend_socket.stat().st_mode & 0o777,0o600)
                gateway = subprocess.Popen(
                    [sys.executable,"-I","-c",GATEWAY_ENTRY,
                     str(code / "private_relay_peer_gateway_v1.py"),
                     str(gateway_socket),str(backend_socket),str(CAPTURE_UID),str(IPC_GID)],
                    env=env,cwd=base,preexec_fn=_drop(RELAY_UID,IPC_GID),
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                live.append(gateway)
                _wait_socket(gateway_socket,gateway)
                self.assertEqual(gateway_socket.stat().st_mode & 0o777,0o660)
                signer = subprocess.Popen(
                    [sys.executable,"-I",str(code / "run_private_owner_signer_service_v1.py")],
                    env=signer_env,cwd=base,preexec_fn=_drop(SIGNER_UID,IPC_GID),
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                live.append(signer)
                _wait_socket(signer_socket,signer)
                self.assertEqual(signer_socket.stat().st_mode & 0o777,0o660)
                req = {
                    "op":"challenge","roomHandle":ROOM,
                    "hostTokenDigest":hashlib.sha256(HOST_TOKEN.encode()).hexdigest()}
                self.assertEqual(
                    _sock_request(gateway_socket,req,STRANGER_UID,STRANGER_GID,[IPC_GID],base),
                    {"ok":False})
                self.assertEqual(
                    _sock_request(signer_socket,{"op":"sign_room_grant","payload":{}},
                                  STRANGER_UID,STRANGER_GID,[IPC_GID],base),
                    {"ok":False})
                self.assertEqual(
                    _sock_request(backend_socket,req,CAPTURE_UID,CAPTURE_GID,[IPC_GID],base),
                    {"error":"PermissionError"})
                client = subprocess.run(
                    ["node",str(code / "cross_uid_capture_client_fixture_v1.mjs"),
                     str(gateway_socket),str(signer_socket),ROOM,RUN_ID,HOST_TOKEN],
                    cwd=base,env=env,preexec_fn=_drop(CAPTURE_UID,CAPTURE_GID,[IPC_GID]),
                    capture_output=True,text=True,timeout=7)
                self.assertEqual(client.returncode,0,client.stderr[-700:])
                self.assertIn("CROSS_UID_CAPTURE_ENROLLMENT_OK",client.stdout)
                self.assertEqual(signer.wait(timeout=4),0)
                self.assertFalse(signer_socket.exists())
                self.assertEqual(backend.wait(timeout=4),0)
                back_out,back_err=backend.communicate(timeout=2)
                self.assertIn("CROSS_UID_DIAGNOSTIC_MATCH_OK",back_out,back_err[-700:])
                print("CROSS_UID_THREE_PRINCIPAL_GRANT_AND_CHECKPOINT_OK")
                print("NOT_A_PRODUCTION_SCENE_ATTESTATION")
            finally:
                for process in reversed(live):
                    if process.poll() is None:
                        process.terminate()
                        try: process.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=2)
                    process.communicate(timeout=2)


if __name__ == "__main__":
    unittest.main()
