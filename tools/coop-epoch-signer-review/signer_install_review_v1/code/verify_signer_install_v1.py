"""Fail-closed signer deployment auditor.

Production CLI accepts NO caller-controlled path or UID. The installed code,
manifest and every directory from / to the install location must be root-owned,
non-group/world-writable and nonsymlink. This must run before loading any keys.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

INSTALL_DIR = "/usr/local/libexec/sam-agi/owner-signer"
SCHEMA = "sam.coop.signer-code-manifest.v1"
MODULES = (
    "private_owner_signer_service_v1.py",
    "run_private_owner_signer_service_v1.py",
    "verify_signer_install_v1.py",
)
MANIFEST = "signer-code-manifest.json"


def _check_node(path, *, uid, directory=False):
    node = os.lstat(path)
    if node.st_uid != uid or node.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise PermissionError("Signer deployment has unsafe ownership or write access")
    if directory:
        if not stat.S_ISDIR(node.st_mode) or node.st_mode & stat.S_ISVTX:
            raise PermissionError("Signer deployment parent is unsafe")
    elif not stat.S_ISREG(node.st_mode) or node.st_nlink != 1:
        raise PermissionError("Signer deployment file is unsafe")
    return node


def _read_checked(path, owner_uid):
    before = _check_node(path, uid=owner_uid)
    if not 20 <= before.st_size <= 50000:
        raise ValueError("Signer deployment file has unexpected size")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        cur = os.fstat(fd)
        if (cur.st_dev, cur.st_ino, cur.st_size, cur.st_mtime_ns) != (
                before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
            raise PermissionError("Signer deployment file changed during open")
        if cur.st_uid != owner_uid or cur.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise PermissionError("Signer deployment file permissions changed")
        raw = os.read(fd, 50001)
        after = os.fstat(fd)
        if len(raw) != cur.st_size or (after.st_ino, after.st_dev,
                                     after.st_size, after.st_mtime_ns) != (
                                         cur.st_ino, cur.st_dev, cur.st_size,
                                         cur.st_mtime_ns):
            raise PermissionError("Signer deployment file changed during read")
        return raw
    finally:
        os.close(fd)


def verify_install_tree(base, *, expected_uid=0, anchor="/"):
    """Only tests may override expected_uid/anchor; production main never does."""
    base = str(base)
    anchor = str(anchor)
    if not (os.path.isabs(base) and os.path.isabs(anchor) and
            os.path.normpath(base) == base and
            os.path.normpath(anchor) == anchor and
            os.path.commonpath((anchor, base)) == anchor):
        raise ValueError("Invalid signer deployment path")
    cursor = Path(base)
    parents = []
    while True:
        parents.append(cursor)
        if str(cursor) == anchor:
            break
        if cursor == cursor.parent:
            raise ValueError("Signer path not below trust anchor")
        cursor = cursor.parent
    for directory in reversed(parents):
        _check_node(directory, uid=expected_uid, directory=True)
    manifest = json.loads(_read_checked(
        str(Path(base) / MANIFEST), expected_uid))
    if (not isinstance(manifest, dict) or
            set(manifest) != {"schema", "files"} or
            manifest["schema"] != SCHEMA or
            not isinstance(manifest["files"], dict) or
            set(manifest["files"]) != set(MODULES)):
        raise ValueError("Untrusted signer code manifest")
    for name in MODULES:
        expected = manifest["files"][name]
        if (not isinstance(expected, str) or len(expected) != 64 or
                any(x not in "0123456789abcdef" for x in expected)):
            raise ValueError("Invalid signer module hash")
        actual = hashlib.sha256(_read_checked(
            str(Path(base) / name), expected_uid)).hexdigest()
        if actual != expected:
            raise PermissionError("Signer executable checksum mismatch")
    return True


def main():
    if len(sys.argv) != 1:
        raise SystemExit("Signer deployment verifier has no runtime options")
    verify_install_tree(INSTALL_DIR, expected_uid=0, anchor="/")
    print("TRUSTED_SIGNER_INSTALL_VERIFIED")


if __name__ == "__main__":
    main()
