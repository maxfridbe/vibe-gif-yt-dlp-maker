#!/usr/bin/env bash
set -e

echo "=== Starting Multi-Platform Build in Container ==="

cd /workspace

echo "=== 1/3: Building Linux Target ==="
cargo tauri build

echo "=== 2/3: Building Windows Target ==="
cargo tauri build --target x86_64-pc-windows-gnu

echo "=== 3/3: Building Android Target (APK) ==="
cargo tauri android build --apk

echo "=== Multi-Platform Build Completed Successfully! ==="
