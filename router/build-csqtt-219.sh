#!/bin/sh
# Native ARM64/musl build from pinned public CSQTT 2.1.9 source.
set -eu
repo=$(pwd)
work=${1:?Specify an empty build directory}
mkdir -p "$work/source" "$work/package"
curl -fLsS --retry 2 https://github.com/amurcanov/csqtt/archive/446293aa2e873ac5323ef6fd2316d9b81d966c11.tar.gz -o "$work/source.tar.gz"
echo "45f98c3eab8bd08aeaf94cf63132a7bc0f815c41dbc5f8603e51d0f18d87c7e9  $work/source.tar.gz" | sha256sum -c -
tar -xzf "$work/source.tar.gz" --strip-components=1 -C "$work/source"
cd "$work/source"
patch --batch --forward -p1 < "$repo/router/patches/csqtt-2.1.9-router-call-closure.patch"
patch --batch --forward -p1 < "$repo/router/patches/csqtt-2.1.9-router-stability.patch"
cp "$repo/router/csqtt-vk-guard.rs" rust-client/vk_account_guard.rs
export CC_aarch64_unknown_linux_musl=musl-gcc
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc
export CARGO_TARGET_DIR="$work/target"
cargo build --release --locked --target aarch64-unknown-linux-musl --manifest-path rust-client/Cargo.toml
cp "$work/target/aarch64-unknown-linux-musl/release/client" "$work/package/client"
# musl-tools supplies libc headers but deliberately excludes Linux UAPI headers.
# Expose only kernel headers, without adding glibc's headers to the search path.
mkdir -p "$work/kernel-headers"
ln -s /usr/include/linux "$work/kernel-headers/linux"
ln -s /usr/include/asm-generic "$work/kernel-headers/asm-generic"
ln -s /usr/include/aarch64-linux-gnu/asm "$work/kernel-headers/asm"
musl-gcc -I "$work/kernel-headers" -Os -static -s "$repo/router/csqtt-tun-fd.c" -o "$work/package/csqtt-tun-fd"
cp "$repo/router/S99csqtt" "$repo/router/csqtt-run-219.sh" "$repo/router/csqtt-js-calls.sh" "$repo/router/csqtt-api-calls.sh" "$repo/router/vk-manual-hashes.sh" "$work/package/"
cp LICENSE "$work/package/LICENSE.CSQTT"
printf '%s\n' 2.1.9-router.2 > "$work/package/client-version"
printf '%s\n' 'upstream=amurcanov/csqtt' 'commit=446293aa2e873ac5323ef6fd2316d9b81d966c11' 'version=2.1.9' > "$work/package/SOURCE"
chmod 755 "$work/package/client" "$work/package/csqtt-tun-fd" "$work/package/"*.sh "$work/package/S99csqtt"
# Corresponding patched source accompanies the executable; no APK/Bionic files.
tar -czf "$repo/csqtt-source-2.1.9-router.2.tar.gz" --exclude='./target' -C "$work/source" rust-client shared LICENSE
tar -czf "$repo/csqtt-client-arm64-v8a.tar.gz" -C "$work/package" .
