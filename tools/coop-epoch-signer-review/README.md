# SAM co-op scene-epoch signer — review-only package

This directory is an isolated, pre-production review copy of the experimental privilege-separated signer and static provisioning checker from 2026-10-31. It is **not installed or running** on the Pi. It contains no keys, room tokens, user credentials, game artwork, or live-frame captures.

The existing public SAM/JevBot paired-PNG + SSE viewer stays authoritative. These tests do **not** authorize scene reconstruction or production signing.

## Focused validation

From this directory:

```sh
python3 -m unittest -q \
  test_private_owner_signer_service_v1.py \
  test_verify_signer_install_v1.py \
  test_staged_signer_isolated_entrypoint_v1.py \
  test_preflight_owner_isolation_v1.py
```

Source SHA-256 digests for the intended root-controlled install copies are in `signer_install_review_v1/code/signer-code-manifest.json`. Any actual install must independently validate those files after a trusted administrator puts them under root-only control. Do not execute the service from this repository checkout, and do not copy test-only fixtures into an elevated service.

## Release blockers

1. Distinct signer/capture-owner Unix identities and an authenticated IPC peer boundary are not provisioned.
2. Production key custody and a trusted owner-to-relay authorization channel are not installed.
3. Relay lifecycle observer patches remain owner-gated and are not applied to the live relay.
4. No independently attested synchronized scene+PNG captures or multi-frame two-seat visual-parity acceptance exists.
5. Redistribution rights for actual game textures have not been cleared.

**Never merge this review branch on the assumption that any of these production gates passed.** Review and integrate under the existing worker/lock ownership and the Mac/Pi consolidation priority.
