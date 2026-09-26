#!/bin/sh
# Build the ios-capture helper as a universal binary into dist/native/.
# The Info.plist is embedded so the Camera prompt has a usage string even
# when the helper is run on its own.
set -e
cd "$(dirname "$0")"
out=../../dist/native
mkdir -p "$out"
tmp=$(mktemp -d)
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos12.0" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
    -o "$tmp/ios-capture-$arch" main.swift
done
lipo -create "$tmp/ios-capture-arm64" "$tmp/ios-capture-x86_64" -output "$out/ios-capture"
rm -rf "$tmp"
# Ad-hoc sign so the binary runs on Apple silicon; electron-builder re-signs
# it with the app's identity when packaging.
codesign --force --sign - "$out/ios-capture"
