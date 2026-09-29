#!/bin/sh
# Build the panel-managed nfqws2 payload without installing the upstream service.
set -eu

version=1.3.1
sha256=9167d72053a83a78f48f6439af38432fb2d1d411fb22c0980240a949ace614df
package="nfqws2-keenetic_${version}_aarch64-3.10.ipk"
out=${1:-xkeen-nfqws2-arm64-v8a.tar.gz}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

curl -fLsS "https://nfqws.github.io/nfqws2-keenetic/aarch64/$package" -o "$work/$package"
printf '%s  %s\n' "$sha256" "$work/$package" | sha256sum -c - >/dev/null
(cd "$work" && tar -xzf "$package" && tar -xzf data.tar.gz)

src="$work/opt/etc/nfqws2"
test -s "$work/opt/usr/bin/nfqws2"
test -s "$src/lua/zapret-lib.lua.gz"
test -s "$src/lua/zapret-antidpi.lua.gz"
test -s "$src/blobs/quic_initial.bin"
test -s "$src/blobs/tls_clienthello.bin"
test -s diagnostics/nfqws-probe/probe

mkdir -p "$work/bundle/nfqws2/lua" "$work/bundle/nfqws2/blobs"
cp "$work/opt/usr/bin/nfqws2" "$work/bundle/engine"
cp "$src/lua/zapret-lib.lua.gz" "$src/lua/zapret-antidpi.lua.gz" "$work/bundle/nfqws2/lua/"
cp "$src/blobs/quic_initial.bin" "$src/blobs/tls_clienthello.bin" "$work/bundle/nfqws2/blobs/"
cp diagnostics/nfqws-probe/probe "$work/bundle/probe"
cp router/nfqws2-canary.sh "$work/bundle/canary.sh"
cp router/nfqws2-probe.sh "$work/bundle/probe-check.sh"
cp router/nfqws2-activate.sh "$work/bundle/activate.sh"
cp router/S98nfqws2-xkeen "$work/bundle/S98nfqws2-xkeen"
chmod 755 "$work/bundle/engine" "$work/bundle/probe" "$work/bundle/canary.sh" "$work/bundle/probe-check.sh" "$work/bundle/activate.sh" "$work/bundle/S98nfqws2-xkeen"
tar -czf "$out" -C "$work/bundle" .
