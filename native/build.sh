#!/usr/bin/env bash
# Builds cometix-native for the platforms whose Bun.ant members it implements
# — Windows, so far — into native/dist/cometix-native.<platform>.node, the
# name build-platform-package.mjs and the polyfill look for. Runs on a
# Windows host with the MSVC toolchain (the CI runners have both targets).
#
# x64 must build. A failed arm64 build is reported and skipped: that package
# then ships without the addon and the bundle keeps its fallbacks.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
for pair in x86_64:x64 aarch64:arm64; do
  triple="${pair%%:*}-pc-windows-msvc"
  arch="${pair##*:}"
  if cargo build --locked --release --target "$triple"; then
    cp "target/$triple/release/cometix_native.dll" "dist/cometix-native.win32-$arch.node"
  elif [ "$arch" = x64 ]; then
    exit 1
  else
    echo "::warning::cometix-native did not build for win32-$arch; that package ships without it"
  fi
done
ls -l dist
