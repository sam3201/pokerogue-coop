"""Private, narrowly scoped one-run Ed25519 signer (LAB ONLY).
Linux AF_UNIX + SO_PEERCRED. No HTTP endpoint, key enrollment, or production
service creation. The process must run under a different UID than its allowed
capture-owner client unless test_allow_same_uid=True, which is for disposable
fixtures ONLY. A signed grant is not a scene or game-state attestation.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import struct
import threading
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

SCHEMA = "sam.coop.owner-room-grant.v1"
ROOM_CHARS = frozenset("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
HEX = frozenset("0123456789abcdef")
PAYLOAD_FIELDS = ("schema", "roomHandle", "runId", "challenge",
                  "hostTokenDigest", "issuedAt", "expiresAt")
REQUEST_FIELDS = ("op", "payload")


def _is_hex(s, n):
    return isinstance(s, str) and len(s) == n and all(c in HEX for c in s)


def _valid_room(room):
    return isinstance(room, str) and len(room) == 6 and all(c in ROOM_CHARS for c in room)


def _private_key_from_file(key_path, signer_uid, expected_pin):
    path = Path(key_path)
    parent = path.parent
    if (str(path) != os.path.abspath(str(path)) or
            path.name != "owner-ed25519.pk8" or
            os.path.realpath(parent) != str(parent)):
        raise ValueError("unsafe signer key path")
    d = os.lstat(parent)
    if not stat.S_ISDIR(d.st_mode) or d.st_uid != signer_uid or d.st_mode & 0o077:
        # Key custody requires mode 0700: the IPC group must not be able
        # to list, enter or replace contents of the private key directory.
        raise ValueError("signer directory is not private")
    before = os.lstat(path)
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != signer_uid or
            before.st_nlink != 1 or before.st_mode & 0o177 or
            not 40 <= before.st_size <= 4096):
        raise ValueError("signer key file not private")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns) != (
                before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
            raise ValueError("signer key was replaced")
        if not stat.S_ISREG(st.st_mode) or st.st_uid != signer_uid or st.st_mode & 0o177:
            raise ValueError("signer key permissions changed")
        # cryptography necessarily makes an immutable bytes copy. The only
        # durable material is the protected file; no raw bytes are returned.
        raw = os.read(fd, 4097)
        after = os.fstat(fd)
        if len(raw) != before.st_size or after.st_mtime_ns != st.st_mtime_ns or (
                after.st_dev, after.st_ino) != (st.st_dev, st.st_ino):
            raise ValueError("signer key changed during read")
        private_key = serialization.load_der_private_key(raw, password=None)
        if not isinstance(private_key, Ed25519PrivateKey):
            raise ValueError("unsupported signer key algorithm")
        public_key = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo)
        key_id = hashlib.sha256(public_key).hexdigest()
        if not _is_hex(expected_pin, 64) or key_id != expected_pin:
            raise ValueError("signer public key pin mismatch")
        return private_key, key_id
    finally:
        os.close(fd)


class OwnerRoomSigner:
    def __init__(self, *, key_path, socket_path, expected_pin,
                 allowed_run_id, allowed_peer_uid, test_allow_same_uid=False,
                 clock=None, stop_when_signed=False):
        if not hasattr(socket, "SO_PEERCRED"):
            raise RuntimeError("Linux SO_PEERCRED required")
        if (not isinstance(allowed_peer_uid, int) or allowed_peer_uid < 0 or
                not isinstance(allowed_run_id, str) or len(allowed_run_id) != 36):
            raise ValueError("invalid capture-owner identity")
        self.signer_uid = os.getuid()
        if self.signer_uid == allowed_peer_uid and not test_allow_same_uid:
            raise PermissionError("production signer and capture owner must have distinct UIDs")
        self.allowed_peer_uid = allowed_peer_uid
        self.allowed_run_id = allowed_run_id
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.key, self.key_id = _private_key_from_file(key_path, self.signer_uid, expected_pin)
        self.path = str(socket_path)
        parent = Path(self.path).parent
        if (self.path != os.path.abspath(self.path) or
                Path(self.path).name != "room-grant-signer.sock" or
                os.path.realpath(parent) != str(parent)):
            raise ValueError("invalid signer IPC socket path")
        dirinfo = os.lstat(parent)
        if (not stat.S_ISDIR(dirinfo.st_mode) or
                dirinfo.st_uid != self.signer_uid or dirinfo.st_mode & 0o027):
            # Mode 0750 allows authorized group traversal, but not
            # write access that could unlink or substitute the socket.
            raise PermissionError("signer IPC directory unsafe")
        self.socket = None
        self.socket_identity = None
        self.used = False
        self.close_event = threading.Event()
        self.count = 0
        self.stop_when_signed = stop_when_signed

    def _sign(self, request):
        if not isinstance(request, dict) or tuple(request.keys()) != REQUEST_FIELDS or (
                request.get("op") != "sign_room_grant"):
            return {"ok": False}
        payload = request.get("payload")
        if not isinstance(payload, dict) or tuple(payload.keys()) != PAYLOAD_FIELDS:
            return {"ok": False}
        now = self.clock()
        issued = payload.get("issuedAt")
        expires = payload.get("expiresAt")
        if (self.used or payload.get("schema") != SCHEMA or
                payload.get("runId") != self.allowed_run_id or
                not _valid_room(payload.get("roomHandle")) or
                not _is_hex(payload.get("challenge"), 64) or
                not _is_hex(payload.get("hostTokenDigest"), 64) or
                type(issued) is not int or type(expires) is not int or
                issued < now - 1000 or issued > now + 1000 or
                not issued < expires <= now + 5000):
            return {"ok": False}
        message = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        signature = base64.urlsafe_b64encode(self.key.sign(message)).decode().rstrip("=")
        self.used = True
        self.count += 1
        if self.stop_when_signed:
            self.close_event.set()
        return {"ok": True, "grant": {
            "schema": SCHEMA, "keyId": self.key_id, "payload": payload,
            "signature": signature
        }}

    def _accept(self, client):
        with client:
            client.settimeout(2)
            try:
                cred = client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                _pid, uid, _gid = struct.unpack("3i", cred)
                if uid != self.allowed_peer_uid:
                    client.sendall(b'{"ok":false}\n')
                    return
                data = bytearray()
                while b"\n" not in data:
                    chunk = client.recv(1024)
                    if not chunk:
                        return
                    data.extend(chunk)
                    if len(data) > 2048:
                        return
                if data.count(b"\n") != 1 or not data.endswith(b"\n"):
                    return
                request = json.loads(data[:-1])
                result = self._sign(request)
                client.sendall(json.dumps(result, separators=(",", ":")).encode() + b"\n")
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                return

    def start(self):
        if self.socket:
            raise RuntimeError("signer already listening")
        if os.path.lexists(self.path):
            raise FileExistsError("signer socket path already used")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            # Create the filesystem socket with restrictive permissions from
            # the first instant of bind(), not after a world-accessible gap.
            old_umask = os.umask(0o117)
            try:
                server.bind(self.path)
            finally:
                os.umask(old_umask)
            server.listen(4)
            os.chmod(self.path, 0o660)  # peer UID still independently checked
            st = os.lstat(self.path)
            self.socket_identity = (st.st_dev, st.st_ino)
            server.settimeout(0.2)
            self.socket = server
        except Exception:
            server.close()
            self.close()
            raise

    def serve(self):
        if self.socket is None:
            raise RuntimeError("signer not listening")
        while not self.close_event.is_set():
            try:
                client, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self._accept(client)

    def close(self):
        self.close_event.set()
        if self.socket:
            self.socket.close()
            self.socket = None
        if self.socket_identity:
            try:
                st = os.lstat(self.path)
                if stat.S_ISSOCK(st.st_mode) and (st.st_dev, st.st_ino) == self.socket_identity:
                    os.unlink(self.path)
            except FileNotFoundError:
                pass
            self.socket_identity = None
