# SAM signer trusted-install review bundle
NO production signer, key, Unix users or systemd unit was installed.

The code/ directory is a staging COPY, not a trusted executable install.
Review code and SHA-256 manifest independently. Under trusted administrator
control only, install its contents root:root with nonwritable permissions
under /usr/local/libexec/sam-agi/owner-signer. Recompute/check hashes after
installation and run /usr/bin/python3 -I
/usr/local/libexec/sam-agi/owner-signer/verify_signer_install_v1.py.
The auditor rejects installation under world/group-writable directories.

The service template must be reviewed and installed only AFTER separate
signer/capture-owner Unix identities, root-managed config, key custody
and worker-to-signer trust boundaries are approved and tested. Its
ExecStart/ExecStartPre use only root-controlled code and Python -I.

Never copy the test-only fixture launcher into the production code directory.
Never put signing keys in this package or under a web-served location.
Keep the current public paired PNG/SSE viewer unchanged.
