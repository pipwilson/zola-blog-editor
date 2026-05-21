# Zola Blog Editor

A desktop blog editor for Zola sites hosted on GitHub. Write and publish posts
without touching a terminal — drafts and published posts are committed directly
to your repository via the GitHub API.

## Features

- Browse all posts in `content/blog/` (or any path you configure)
- Save drafts (`draft = true` in frontmatter) and publish with one click
- Unpublish a live post back to draft
- Side-by-side Markdown preview with resizable splitter
- Frontmatter fields: title, date, tags, slug, description
- Config persisted across sessions via OS-native store (Tauri plugin-store)
- Keyboard shortcuts: `Ctrl+S` save draft, `Ctrl+Enter` publish, `Ctrl+N` new post, `Ctrl+P` preview

## Setup

### 1. Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# On Linux, install WebKit and other deps:
sudo apt install libwebkit2gtk-4.1-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev build-essential

# Install Node (if not present), then Tauri CLI:
npm install
```

### 2. Get a GitHub Personal Access Token

1. Go to github.com/settings/tokens
2. Generate new token → Classic
3. Check the **repo** scope
4. Copy the token (you'll only see it once)

### 3. Run in development

```bash
npm run dev
```

This opens a live-reloading window. The frontend is in `src/index.html`.

### 4. Build a release binary

```bash
npm run build
```

Output lands in `src-tauri/target/release/bundle/`:
- `.deb` / `.AppImage` on Linux
- `.dmg` / `.app` on macOS
- `.msi` / `.exe` on Windows

## Project structure

```
zola-blog-editor/
├── src/
│   └── index.html          # Full frontend (HTML + CSS + JS)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs         # Tauri entry point
│   │   └── lib.rs          # Plugin registration
│   ├── Cargo.toml          # Rust dependencies
│   └── tauri.conf.json     # App config (name, window size, bundle)
└── package.json
```

## Configuration

Settings are entered in the app's settings dialog (`Ctrl+,`) and persisted
automatically. Fields:

| Field | Example |
|---|---|
| Token | `ghp_xxxxxxxxxxxx` |
| Repository | `philwilson/my-blog` |
| Branch | `main` |
| Posts path | `content/blog` |

## Notes on token storage

In the Tauri app, config is stored via `tauri-plugin-store` in a JSON file in
your OS app data directory (`~/.local/share/zola-blog-editor/` on Linux,
`~/Library/Application Support/` on macOS). This is not the OS keychain — if
you want proper keychain storage, add `tauri-plugin-stronghold` or
`tauri-plugin-keychain` and replace the `cfgSet`/`cfgGet` calls for the token.

## Zola frontmatter format

Posts are written with TOML frontmatter (`+++` delimiters):

```toml
+++
title = "My post title"
date = 2025-05-19
draft = true
description = "A brief summary"

[taxonomies]
tags = ["zola", "web"]
+++

Post body here...
```
