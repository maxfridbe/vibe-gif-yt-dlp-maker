# YouTube GIF Maker

A cross-platform desktop, mobile, and web application built with **Rust**, **Tauri v2**, **Axum**, and **ffmpeg.wasm**.

It allows you to:
1. **Paste YouTube URLs** or share them directly on Android (resolves streams natively via Rust & Axum backend—no Node.js or external `yt-dlp` installation required).
2. **Drop local media & subtitles** (`.mp4`, `.webm`, `.srt`, `.vtt`, etc.).
3. **Visual Subtitle Editor**: Fine-tune timing, text, and styles in a WYSIWYG editor.
4. **Native GIF & Video Export**: Generate looped GIFs, WebP, MP4, or SRT files client-side using `ffmpeg.wasm`.

---

## Supported Platforms

- **Linux** (`.AppImage`, `.deb`)
- **macOS** (`.dmg`, `.app`)
- **Windows** (`.msi`, `.exe`)
- **Android** (`.apk` with YouTube share intent support)
- **Web / Static** (GitHub Pages)

---

## Development

Requirements: [Rust](https://www.rust-lang.org/) and `tauri-cli` (`cargo install tauri-cli --version "^2.0.0"`). Zero Node.js or npm dependencies required.

```bash
# Run the app locally in development mode
cargo tauri dev

# Build production binary for current OS
cargo tauri build

# Build Android APK
cargo tauri android build --apk
```

---

## Podman Multi-Target Build Container

You can build Linux, Windows (`x86_64-pc-windows-gnu`), and Android targets in an isolated Podman container without installing cross-compilers locally:

```bash
# Build container image and execute multi-target compilation
./run-podman-build.sh
```

---

## GitHub Pages

A web version of the editor is hosted on GitHub Pages with COOP/COEP headers enabled via service worker (`coi-serviceworker.js`) to support `ffmpeg.wasm` multithreading.
