"""Lab-only AF_UNIX credential gateway for owner -> relay grant IPC.

The relay-facing backend remains mode 0600 in a 0700 relay-owned directory.
The public-facing Unix socket can be 0660 inside a relay-owned 0750 directory.
Linux SO_PEERCRED restricts requests to ONE configured capture-owner UID.
No HTTP/TCP, no signer key access, no production permission to promote scenes.
Must run under a dedicated RELAY UID, distinct from capture and signer UIDs.
"""
import json
import os
from pathlib import Path
import socket
import stat
import struct
import threading

FIELDS = {"challenge": ("op", "roomHandle", "hostTokenDigest"),
          "authorize": ("op", "grant")}


def check_private_path(path, name, *, directory_mode, file_mode, gid=None):
    p = Path(path)
    if (not p.is_absolute() or os.path.normpath(str(p)) != str(p)
            or p.name != name or os.path.realpath(p.parent) != str(p.parent)):
        raise ValueError("Invalid relay IPC path")
    parent = os.lstat(p.parent)
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) != directory_mode
            or (gid is not None and parent.st_gid != gid)):
        raise PermissionError("Unsafe relay IPC directory")
    if file_mode is not None:
        node = os.lstat(p)
        if (not stat.S_ISSOCK(node.st_mode) or node.st_uid != os.getuid()
                or stat.S_IMODE(node.st_mode) != file_mode):
            raise PermissionError("Unsafe relay backend socket")
    return str(p)


def valid_request(value):
    if type(value) is not dict or value.get("op") not in FIELDS:
        return False
    return tuple(value.keys()) == FIELDS[value["op"]]


class RelayPeerGateway:
    def __init__(self, *, gateway_path, backend_path,
                 capture_uid, ipc_gid, test_same_uid=False):
        if not hasattr(socket, "SO_PEERCRED"):
            raise RuntimeError("SO_PEERCRED is required")
        if (type(capture_uid) is not int or capture_uid <= 0
                or type(ipc_gid) is not int or ipc_gid < 0):
            raise ValueError("Invalid capture identity")
        if capture_uid == os.getuid() and not test_same_uid:
            raise PermissionError("Relay and capture UIDs must differ")
        self.capture_uid = capture_uid
        self.ipc_gid = ipc_gid
        self.gateway_path = check_private_path(
            gateway_path, "capture-owner-gateway.sock",
            directory_mode=0o750, file_mode=None, gid=ipc_gid)
        self.backend_path = check_private_path(
            backend_path, "owner-grants.sock",
            directory_mode=0o700, file_mode=0o600)
        self.socket = None
        self.identity = None
        self.closed = threading.Event()
        self.forwarded = 0
        self.denied = 0

    def start(self):
        if self.socket is not None:
            raise RuntimeError("Already started")
        if os.path.lexists(self.gateway_path):
            raise FileExistsError("Gateway path exists")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            old = os.umask(0o117)
            try:
                sock.bind(self.gateway_path)
            finally:
                os.umask(old)
            # Deliberately no group/world access between bind and chmod.
            os.chmod(self.gateway_path, 0o660)
            node = os.lstat(self.gateway_path)
            if not stat.S_ISSOCK(node.st_mode) or stat.S_IMODE(node.st_mode) != 0o660:
                raise PermissionError("Gateway mode changed")
            self.identity = (node.st_dev, node.st_ino)
            sock.listen(4)
            sock.settimeout(0.2)
            self.socket = sock
        except Exception:
            sock.close()
            self.close()
            raise

    def _client(self, client):
        with client:
            client.settimeout(2)
            try:
                creds = client.getsockopt(
                    socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                _pid, uid, _gid = struct.unpack("3i", creds)
                if uid != self.capture_uid:
                    self.denied += 1
                    client.sendall(b'{"ok":false}\n')
                    return
                data = bytearray()
                while b"\n" not in data:
                    fragment = client.recv(1024)
                    if not fragment:
                        return
                    data.extend(fragment)
                    if len(data) > 4096:
                        return
                if data.count(b"\n") != 1 or not data.endswith(b"\n"):
                    return
                req = json.loads(data[:-1])
                if not valid_request(req):
                    client.sendall(b'{"ok":false}\n')
                    return
                # The private backend remains accessible only to the relay UID.
                check_private_path(
                    self.backend_path, "owner-grants.sock",
                    directory_mode=0o700, file_mode=0o600)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as backend:
                    backend.settimeout(2)
                    backend.connect(self.backend_path)
                    peer = backend.getsockopt(
                        socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                    _backend_pid, backend_uid, _backend_gid = struct.unpack("3i", peer)
                    if backend_uid != os.getuid():
                        raise PermissionError("Backend process UID mismatch")
                    backend.sendall(data)
                    reply = bytearray()
                    while b"\n" not in reply:
                        chunk = backend.recv(1024)
                        if not chunk:
                            return
                        reply.extend(chunk)
                        if len(reply) > 4096:
                            return
                    if reply.count(b"\n") != 1 or not reply.endswith(b"\n"):
                        return
                    result = json.loads(reply[:-1])
                    if type(result) is not dict or type(result.get("ok")) is not bool:
                        return
                    if result["ok"] is False:
                        if set(result) != {"ok"}:
                            return
                    elif req["op"] == "challenge":
                        if (set(result) != {"ok", "challenge", "expiresAt"}
                                or type(result["challenge"]) is not str
                                or len(result["challenge"]) != 64
                                or type(result["expiresAt"]) is not int):
                            return
                    elif set(result) != {"ok"}:
                        return
                    self.forwarded += 1
                    client.sendall(reply)
            except (OSError, UnicodeError, ValueError, TypeError,
                    json.JSONDecodeError, PermissionError):
                return

    def serve(self):
        if self.socket is None:
            raise RuntimeError("Not started")
        while not self.closed.is_set():
            try:
                client, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self._client(client)

    def close(self):
        self.closed.set()
        if self.socket:
            self.socket.close()
            self.socket = None
        if self.identity:
            try:
                node = os.lstat(self.gateway_path)
                if stat.S_ISSOCK(node.st_mode) and (
                        node.st_dev, node.st_ino) == self.identity:
                    os.unlink(self.gateway_path)
            except FileNotFoundError:
                pass
            self.identity = None
