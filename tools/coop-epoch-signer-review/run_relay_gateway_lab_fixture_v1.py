"""Disposable-only gateway launcher. NEVER install as a systemd service."""
import os
import signal
import sys
from private_relay_peer_gateway_v1 import RelayPeerGateway

def main():
    if (os.environ.get("SAM_RELAY_GATEWAY_LAB_ONLY") != "1"
            or len(sys.argv) != 5):
        raise SystemExit("LAB_ONLY fixture refused")
    front, back, uid, gid = sys.argv[1:]
    gateway = RelayPeerGateway(
        gateway_path=front,
        backend_path=back,
        capture_uid=int(uid),
        ipc_gid=int(gid),
        test_same_uid=True,
    )
    def stop(_sig, _frame):
        gateway.close()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        gateway.start()
        print("RELAY_PEER_GATEWAY_LAB_READY", flush=True)
        gateway.serve()
    finally:
        gateway.close()

if __name__ == "__main__":
    main()
