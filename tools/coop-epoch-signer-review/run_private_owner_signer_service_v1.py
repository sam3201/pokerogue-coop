"""Production signer entrypoint template. Only works with preprovisioned users,
keys and an authenticated allowlisted run ID. Installs nothing by itself.
Do not start as sam3201 or under the game/browser's UID.
"""
import importlib.util
import os
from pathlib import Path
import signal

# Python -I excludes local script directories from sys.path. Explicitly load
# the companion module from the code directory verified by ExecStartPre.
# Never add a user-writable path or PYTHONPATH to an elevated signer process.
_root = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "_sam_private_owner_signer", _root / "private_owner_signer_service_v1.py")
if _spec is None or _spec.loader is None:
    raise SystemExit("Trusted owner-signer module unavailable")
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
OwnerRoomSigner = _module.OwnerRoomSigner

def required(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit("Required signer configuration missing: " + name)
    return value

def main():
    service = OwnerRoomSigner(
        key_path=required("SAM_SIGNER_KEY_PATH"),
        socket_path=required("SAM_SIGNER_SOCKET_PATH"),
        expected_pin=required("SAM_SIGNER_PUBLIC_PIN"),
        allowed_run_id=required("SAM_SIGNER_RUN_ID"),
        allowed_peer_uid=int(required("SAM_SIGNER_CAPTURE_UID")),
        # No test override: the capture owner must be a DISTINCT OS UID.
        test_allow_same_uid=False,
        stop_when_signed=True
    )
    def stop(_signal, _frame):
        service.close()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        service.start()
        print("PRIVATE_SIGNER_READY",flush=True)
        service.serve()
    finally:
        service.close()

if __name__ == "__main__":
    main()
