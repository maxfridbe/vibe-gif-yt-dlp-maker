#!/usr/bin/env bash
set -e

IMAGE_NAME="youtube-gif-maker-builder:latest"

echo "=== Building Podman Builder Image: ${IMAGE_NAME} ==="
podman build -t "${IMAGE_NAME}" -f Containerfile .

echo "=== Running Multi-Target Build Container ==="
podman run --rm \
    -v "$(pwd):/workspace:z" \
    "${IMAGE_NAME}"

echo "=== Podman build completed! Check src-tauri/target/ for output binaries and APKs. ==="
