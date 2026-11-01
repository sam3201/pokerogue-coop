#!/usr/bin/env bash
# Review-only, opt-in bootstrap for SAM co-op. Default --plan changes nothing.
# --apply creates nonlogin users and group, root-controlled, SHA-pinned signer
# code and an EMPTY signer-private state dir. It NEVER installs keys,
# service units, runtime sockets or touches a running capture/relay.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
mode="${1:---plan}"
[[ "$#" -eq 1 ]] || { echo "Usage: $0 --plan|--apply|--verify"; exit 64; }
case "$mode" in --plan|--apply|--verify) ;; *) exit 64 ;; esac
here="$(cd "$(dirname "$0")" && pwd -P)"
src="$here/signer_install_review_v1/code"
dst=/usr/local/libexec/sam-agi/owner-signer
state=/var/lib/sam-coop-signer
die(){ echo "REFUSED: $*" >&2; exit 70; }
check_source(){
  [[ -d "$src" && ! -L "$src" ]] || die "unavailable or symlinked signer source"
  (cd "$src"; sha256sum --check --status <<'PINS'
6f81e08179be899f9ba8eeb7febc3d8c40208105af483c28043d32148c594587  private_owner_signer_service_v1.py
252065ecda182c9466e048f5fb6c1efb436fd09691fd7d079712f0f85b6099f0  run_private_owner_signer_service_v1.py
ab772bf5a3ab12dfdaa8656cda62d8a320bde8a68e226cdddb5559fb43b8e143  verify_signer_install_v1.py
PINS
  ) || die "source differs from independently reviewed digest"
  python3 -I - "$src" <<'PY'
import hashlib,json,pathlib,stat,sys
d=pathlib.Path(sys.argv[1])
m=json.loads((d/"signer-code-manifest.json").read_text())
p={
"private_owner_signer_service_v1.py":"6f81e08179be899f9ba8eeb7febc3d8c40208105af483c28043d32148c594587",
"run_private_owner_signer_service_v1.py":"252065ecda182c9466e048f5fb6c1efb436fd09691fd7d079712f0f85b6099f0",
"verify_signer_install_v1.py":"ab772bf5a3ab12dfdaa8656cda62d8a320bde8a68e226cdddb5559fb43b8e143"}
assert m=={"schema":"sam.coop.signer-code-manifest.v1","files":p}
for n in (*p,"signer-code-manifest.json"):
    s=(d/n).lstat()
    assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<50000
for n,sha in p.items(): assert hashlib.sha256((d/n).read_bytes()).hexdigest()==sha
print("PINNED_SOURCES_OK")
PY
}
verify_ids(){
  getent group sam-coop-ipc >/dev/null || die "IPC group missing"
  for u in sam-coop-signer sam-coop-capture sam-coop-relay; do
    getent passwd "$u" >/dev/null || die "$u missing"
    [[ "$(getent passwd "$u" | cut -d: -f7)" = /usr/sbin/nologin ]] ||
      die "$u login must be disabled"
    id -nG "$u" | tr ' ' '\n' | grep -Fxq sam-coop-ipc ||
      die "$u lacks IPC membership"
  done
  getent passwd sam-coop-game >/dev/null || die "game UID missing"
  [[ "$(getent passwd sam-coop-game | cut -d: -f7)" = /usr/sbin/nologin ]] ||
    die "game login must be disabled"
  if id -nG sam-coop-game | tr ' ' '\n' | grep -Fxq sam-coop-ipc; then
    die "untrusted game has IPC group"
  fi
  if id -nG sam3201 | tr ' ' '\n' | grep -Fxq sam-coop-ipc; then
    die "general SAM user has IPC group"
  fi
  [[ $(for u in sam-coop-signer sam-coop-capture sam-coop-relay sam-coop-game sam3201; do
      id -u "$u"; done | sort -u | wc -l) -eq 5 ]] ||
    die "one or more service UID identities are duplicated"
  echo "SEPARATE_NONLOGIN_UIDS_OK"
}
verify_install(){
  python3 -I "$dst/verify_signer_install_v1.py" ||
    die "trusted code integrity failed"
  for f in private_owner_signer_service_v1.py run_private_owner_signer_service_v1.py verify_signer_install_v1.py signer-code-manifest.json; do
    [[ "$(stat -c %a "$dst/$f")" == 644 ]] || die "$f mode is unsafe"
  done
  [[ "$(stat -c '%U:%G:%a' "$state")" = "sam-coop-signer:sam-coop-signer:700" ]] ||
    die "signer-private state custody mode incorrect"
  echo "ROOT_CONTROLLED_SIGNER_CODE_OK"
}
check_source
if [[ "$mode" == --plan ]]; then
  echo "PLAN_ONLY: create dedicated nologin signer/capture/relay/game UIDs,"
  echo " shared IPC group, root-owned signer code, private EMPTY state dir."
  echo " NO private keys, pin config, systemd unit, runtime IPC, live work."
  exit 0
fi
if [[ "$mode" == --verify ]]; then verify_ids; verify_install; exit 0; fi
[[ $EUID -eq 0 ]] || die "root required for --apply"
[[ -e /usr/sbin/nologin ]] || die "nologin unavailable"
for p in "$dst" "$state"; do
  [[ ! -L "$p" && ( ! -e "$p" || -d "$p" ) ]] ||
    die "unsafe or unexpected destination $p"
done
# Refuse unsafe system parent paths before touching users or directories.
python3 -I - <<'PY'
import os,stat
for p in ("/","/usr","/usr/local","/var","/var/lib"):
    st=os.lstat(p)
    assert st.st_uid==0 and stat.S_ISDIR(st.st_mode)
    assert not st.st_mode & (stat.S_IWGRP|stat.S_IWOTH)
PY
getent group sam-coop-ipc >/dev/null || groupadd --system sam-coop-ipc
for u in sam-coop-signer sam-coop-capture sam-coop-relay; do
  getent passwd "$u" >/dev/null ||
    useradd --system --user-group --no-create-home \
      --shell /usr/sbin/nologin --groups sam-coop-ipc "$u"
done
getent passwd sam-coop-game >/dev/null ||
  useradd --system --user-group --no-create-home \
    --shell /usr/sbin/nologin sam-coop-game
verify_ids
install -d -o root -g root -m 0755 /usr/local/libexec
install -d -o root -g root -m 0755 /usr/local/libexec/sam-agi
install -d -o root -g root -m 0755 "$dst"
for f in private_owner_signer_service_v1.py run_private_owner_signer_service_v1.py verify_signer_install_v1.py signer-code-manifest.json; do
  if [[ -e "$dst/$f" || -L "$dst/$f" ]]; then
    cmp -s "$src/$f" "$dst/$f" || die "installed $f differs; no overwrite"
  else
    install -o root -g root -m 0644 "$src/$f" "$dst/$f"
  fi
done
if [[ ! -e "$state" ]]; then
  install -d -o sam-coop-signer -g sam-coop-signer -m 0700 "$state"
fi
verify_install
if systemctl is-active --quiet sam-coop-owner-signer.service; then
  die "signer unexpectedly active"
fi
echo "STAGED_ONLY_OK; signer not started and no signing key generated"
