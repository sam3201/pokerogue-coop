"""Disposable test launcher for OwnerRoomSigner. NEVER use as a production service.

Requires SAM_SIGNER_LAB_ONLY=1, a temporary key/socket path, and a same-UID
fixture. The production signer must run under a distinct Unix identity.
"""
import os
import signal
import sys
from private_owner_signer_service_v1 import OwnerRoomSigner

def main():
    if os.environ.get("SAM_SIGNER_LAB_ONLY") != "1" or len(sys.argv) != 6:
        raise SystemExit("This launcher is for isolated tests only")
    key_path, socket_path, pin, run_id, uid_text = sys.argv[1:]
    if not (key_path.startswith("/tmp/sam-owner-key-fixture-") and
            socket_path.startswith("/tmp/sam-owner-key-fixture-")):
        raise SystemExit("Refusing non-fixture paths")
    service = OwnerRoomSigner(
        key_path=key_path, socket_path=socket_path,
        expected_pin=pin, allowed_run_id=run_id,
        allowed_peer_uid=int(uid_text), test_allow_same_uid=True
    )
    def stop(_signal, _frame):
        service.close()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        service.start()
        print("ISOLATED_SIGNER_READY", flush=True)
        service.serve()
    finally:
        service.close()

if __name__ == "__main__":
    main()
