#!/bin/bash
# fetch the pinned vale binary. the binary is ~30 MB and never committed, so it lands in two
# gitignored spots: tools/bin/vale is the canonical path the prose:check script uses, and
# tools/.vale/vale is a link kept because .claude/hooks/anti-slop-calibrate.sh already probes
# that path (the socket predates this script, BL-324). one download, two names.
#
# unlike DRIFT's version this verifies a sha256 before extracting: a piped
# `curl | tar` cannot be checked, so the tarball lands on disk first. SHA256 below is
# upstream's own published vale_${VERSION}_checksums.txt entry, re-verified 2026-08-07.
#
# bump VERSION and SHA256 together and deliberately, then re-run
# .claude/hooks/anti-slop-calibrate.sh (the calibration invariant).
set -euo pipefail

VERSION=3.15.1
SHA256=c024d9c157874fb043d4f24a055d60050d1bb18755251f590593eed5bace1857

TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$TOOLS/bin"
BIN="$BIN_DIR/vale"
COMPAT_DIR="$TOOLS/.vale"

# the calibrate hook looks for tools/.vale/vale, so keep that name pointing at the real binary
link_compat() {
  mkdir -p "$COMPAT_DIR"
  rm -f "$COMPAT_DIR/vale"
  ln -s ../bin/vale "$COMPAT_DIR/vale" 2>/dev/null || cp "$BIN" "$COMPAT_DIR/vale"
}

if [[ -x "$BIN" ]] && "$BIN" --version 2>/dev/null | grep -q "$VERSION"; then
  echo "vale $VERSION already at $BIN"
  link_compat
  exit 0
fi

mkdir -p "$BIN_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

TARBALL="vale_${VERSION}_Linux_64-bit.tar.gz"
echo "downloading $TARBALL"
curl -sL --fail -o "$TMP/$TARBALL" \
  "https://github.com/vale-cli/vale/releases/download/v${VERSION}/${TARBALL}"

echo "$SHA256  $TMP/$TARBALL" | sha256sum -c - >/dev/null || {
  echo "get-vale: checksum mismatch, refusing to install" >&2
  echo "  expected $SHA256" >&2
  echo "  got      $(sha256sum "$TMP/$TARBALL" | cut -d' ' -f1)" >&2
  exit 1
}

tar xz -C "$BIN_DIR" -f "$TMP/$TARBALL" vale
chmod +x "$BIN"
link_compat
"$BIN" --version
