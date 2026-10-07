# Vibe GIF & yt-dlp Maker (Clip Editor)

A cross-platform desktop application built with Electron, TypeScript, and `ffmpeg.wasm`.

It allows you to:
1. Paste YouTube URLs (resolves video and subtitles using your system's `yt-dlp`).
2. Drop local video and subtitle files (`.mp4`, `.srt`, `.vtt`, etc.).
3. Edit subtitles in a visual WYSIWYG editor.
4. Export a perfectly looped MP4, WebP, GIF, or SRT file natively—no external cloud required.

## Installation

Download the latest release for your platform from the [Releases page](../../releases) (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`).

> **Note**: For downloading YouTube videos, you must have `yt-dlp` installed and available in your system's `PATH`.

## Development

```bash
# Install dependencies
npm install

# Run the app locally
npm start

# Build binaries
npm run build
```

## GitHub Pages

A web-only version of the editor is published to GitHub Pages. Due to browser security and YouTube restrictions, you cannot paste YouTube links in the web-only version. However, you can drag and drop local media and subtitles into the web version to edit and export them perfectly!
