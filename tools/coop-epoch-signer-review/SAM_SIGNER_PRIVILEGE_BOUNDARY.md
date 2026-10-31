# SAM capture-owner signer: deployment boundary

Status: TESTED IN ISOLATION. NOT INSTALLED. DO NOT PROMOTE the scene renderer.

## Required identities and ownership

The capture-owner and signing processes must run under two distinct Linux
user IDs. The general sam3201 account and the browser/relay worker should
have neither identity's signing key access.

* signer UID: sam-coop-signer; owning group: sam-coop-ipc
* capture-owner UID: sam-coop-capture; supplementary group: sam-coop-ipc
* key: /var/lib/sam-coop-signer/owner-ed25519.pk8, owner signer, mode 0600
* signer state dir: /var/lib/sam-coop-signer, mode 0700, signer-owned
* signer socket: /run/sam-coop-signer/room-grant-signer.sock, mode 0660,
  inside a signer-owned mode 0750 directory, group sam-coop-ipc
* config /etc/sam-agi/owner-signer.env: root-managed; contains paths,
  independently pinned SPKI SHA-256, one allowed runId and the numeric
  capture-owner UID. NO private keys and NO bearer room tokens.

The signer verifies SO_PEERCRED on every AF_UNIX connection, requiring
the EXACT configured capture-owner UID. A Unix group membership alone
does not grant authorization. Requests are bounded; the service signs
only a short-lived Ed25519 room grant for exactly one configured run,
and terminates after its first signature. The relay's separate grant
broker must verify the room-specific random challenge, actual host-seat
token digest, time bounds and one-time run binding. A signed grant does
NOT attest game simulation correctness or postrender scene identity.

## Verification and deployment gates

The provided .service.template has no Install section and must NOT be
installed until user identities, filesystem ACLs, capture-owner migration,
key-provisioning path, key pin distribution and rollback have been reviewed
by the relevant owner. Any production API that lets a browser obtain
signatures or select the signing run ID would violate the trust boundary.
Never use run_disposable_signer_fixture_v1.py outside tests, because it
explicitly permits same-UID signing.

This staging code has not created a production key or account and has
not changed any active services, public files or the game capture writer.

For isolated verification:
  python3 -m unittest -q test_private_owner_signer_service_v1.py
  bash check_private_scene_transport_v1.sh --relay

Remaining unrelated release gates: owner-issued relay room registration
and same-epoch scene/PNG correlation from a trusted capture transaction,
full two-seat rendering fidelity and review of redistribution rights.
Keep PNG/SSE public fallback active.


## Root-owned executable boundary — mandatory correction

Production systemd ExecStart and ExecStartPre must use Python isolated
mode (-I) and only these root-owned installed modules:
  /usr/local/libexec/sam-agi/owner-signer/private_owner_signer_service_v1.py
  /usr/local/libexec/sam-agi/owner-signer/run_private_owner_signer_service_v1.py
  /usr/local/libexec/sam-agi/owner-signer/verify_signer_install_v1.py

The root-owned install directory and ALL its parent directories must
be nonsymlink, non-group/world-writable, and each module must match the
root-owned signer-code-manifest.json. An ExecStartPre integrity audit
checks this before the one-run signer entrypoint executes. The signer
entrypoint explicitly imports its sibling from the installed path
because Python -I does not add that directory to sys.path.

The signer_install_review_v1/ bundle is only a review artifact. DO
NOT execute it as the privileged signer; DO NOT copy it blindly.
No production signer identity/key/service exists yet. A root
administrator must review and provision them after migration-owner
approval. The relay-facing grant IPC is also same-UID protected in
the prototype, not proven separate-principal authentication.
