"""Read-only provisioning checks for SAM owner signer; never authorizes production.
Does not open keys, modify permissions, create accounts or activate services.
"""
import grp
import json
import os
from pathlib import Path
import pwd
import stat
import sys

CODE_DIR = Path("/usr/local/libexec/sam-agi/owner-signer")
STATE_DIR = Path("/var/lib/sam-coop-signer")
KEY = STATE_DIR / "owner-ed25519.pk8"
RUNTIME_DIR = Path("/run/sam-coop-signer")
CONFIG = Path("/etc/sam-agi/owner-signer.env")
UNIT = Path("/etc/systemd/system/sam-coop-owner-signer.service")
RELAY_RUNTIME_DIR = Path("/run/sam-coop-relay")
RELAY_EXTERNAL_DIR = RELAY_RUNTIME_DIR / "capture"
RELAY_INTERNAL_DIR = RELAY_RUNTIME_DIR / "private"

CHECKS = (
    "distinct_os_identities",
    "distinct_relay_os_identity",
    "relay_runtime_root_directory",
    "relay_capture_gateway_directory",
    "relay_private_backend_directory",
    "signer_private_state_directory",
    "signer_private_key_metadata",
    "root_owned_code_path",
    "root_owned_configuration",
    "root_owned_service_unit",
    "runtime_socket_directory",
)


def metadata(path, uid, mode, *, directory=False):
    try:
        st = os.lstat(path)
    except (OSError, ValueError):
        return False
    return (st.st_uid == uid and stat.S_IMODE(st.st_mode) == mode
            and (stat.S_ISDIR(st.st_mode) if directory
                 else stat.S_ISREG(st.st_mode) and st.st_nlink == 1))


def identity_gate():
    try:
        signer = pwd.getpwnam("sam-coop-signer")
        capture = pwd.getpwnam("sam-coop-capture")
        general = pwd.getpwnam("sam3201")
        group = grp.getgrnam("sam-coop-ipc")
    except KeyError:
        return False, None, None, None
    separated = len({signer.pw_uid, capture.pw_uid, general.pw_uid, 0}) == 4
    capture_member = capture.pw_gid == group.gr_gid or capture.pw_name in group.gr_mem
    signer_member = signer.pw_gid == group.gr_gid or signer.pw_name in group.gr_mem
    return separated and capture_member and signer_member, signer.pw_uid, group.gr_gid, capture.pw_uid


def relay_identity_gate():
    try:
        signer = pwd.getpwnam("sam-coop-signer")
        capture = pwd.getpwnam("sam-coop-capture")
        relay = pwd.getpwnam("sam-coop-relay")
        general = pwd.getpwnam("sam3201")
        group = grp.getgrnam("sam-coop-ipc")
    except KeyError:
        return False, None
    distinct = len({0, signer.pw_uid, capture.pw_uid,
                    relay.pw_uid, general.pw_uid}) == 5
    relay_member = (relay.pw_gid == group.gr_gid or
                    relay.pw_name in group.gr_mem)
    return distinct and relay_member, relay.pw_uid


def group_directory(path, uid, gid, mode):
    if not metadata(path, uid, mode, directory=True):
        return False
    try:
        return os.lstat(path).st_gid == gid
    except OSError:
        return False


def code_path_root_owned():
    # This is only metadata preflight. Full SHA-256 verification remains the
    # separate installed verify_signer_install_v1.py requirement.
    for path in (CODE_DIR, *CODE_DIR.parents):
        try:
            st = os.lstat(path)
            if (st.st_uid != 0 or not stat.S_ISDIR(st.st_mode)
                    or stat.S_IMODE(st.st_mode) & 0o022):
                return False
        except OSError:
            return False
    required = (
        "private_owner_signer_service_v1.py",
        "run_private_owner_signer_service_v1.py",
        "verify_signer_install_v1.py",
        "signer-code-manifest.json",
    )
    return all(
        metadata(CODE_DIR / name, 0, 0o644) or
        metadata(CODE_DIR / name, 0, 0o444) for name in required
    )


def facts():
    identities, signer_uid, group_gid, _capture_uid = identity_gate()
    relay_identity, relay_uid = relay_identity_gate()
    signer_uid = -1 if signer_uid is None else signer_uid
    relay_uid = -1 if relay_uid is None else relay_uid
    runtime_ok = metadata(RUNTIME_DIR, signer_uid, 0o750, directory=True)
    if runtime_ok:
        runtime_ok = os.lstat(RUNTIME_DIR).st_gid == group_gid
    return {
        "distinct_os_identities": identities,
        "distinct_relay_os_identity": relay_identity,
        "relay_runtime_root_directory": group_directory(
            RELAY_RUNTIME_DIR, relay_uid, group_gid, 0o750),
        "relay_capture_gateway_directory": group_directory(
            RELAY_EXTERNAL_DIR, relay_uid, group_gid, 0o750),
        "relay_private_backend_directory": metadata(
            RELAY_INTERNAL_DIR, relay_uid, 0o700, directory=True),
        "signer_private_state_directory": metadata(
            STATE_DIR, signer_uid, 0o700, directory=True),
        "signer_private_key_metadata": metadata(KEY, signer_uid, 0o600),
        "root_owned_code_path": code_path_root_owned(),
        "root_owned_configuration": metadata(CONFIG, 0, 0o600),
        "root_owned_service_unit": metadata(UNIT, 0, 0o644),
        "runtime_socket_directory": runtime_ok,
    }


def assess(snapshot):
    if set(snapshot) != set(CHECKS) or any(type(snapshot[k]) is not bool for k in CHECKS):
        raise ValueError("Incomplete provisioning snapshot")
    missing = [name for name in CHECKS if not snapshot[name]]
    return {
        "schema": "sam.coop.owner-isolation-preflight.v1",
        "static_prerequisites_met": not missing,
        "blocked_checks": missing,
        "capture_worker_authenticated": False,
        "relay_integration_proven": False,
        "scene_epoch_attested": False,
        "production_scene_eligible": False,
    }


def main():
    if len(sys.argv) != 1:
        raise SystemExit("This preflight accepts no configuration arguments")
    report = assess(facts())
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["static_prerequisites_met"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
