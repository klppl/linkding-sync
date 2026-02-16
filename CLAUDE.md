# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome/Chromium extension (Manifest V3) that syncs bookmarks from a self-hosted Linkding instance into the browser's bookmark tree, organized by tags. Works with Chrome, Vivaldi, Edge, Brave, and other Chromium-based browsers.

## Development

No build step, bundler, or package manager. The extension is plain vanilla JS/HTML/CSS loaded directly by the browser.

**To develop/test:** Load as an unpacked extension at `chrome://extensions/` (or `vivaldi://extensions/`, etc.) with Developer Mode enabled. Reload the extension after code changes.

**No test framework is configured.** Manual testing via the browser extension UI.

## Architecture

```
popup.html/js  ──message──▶  background.js  ──imports──▶  sync.js
options.html/js ──storage──▶  background.js                  │
                                    │                         │
                              chrome.alarms           Linkding REST API
                              (auto-sync)             Chrome Bookmarks API
```

- **`sync.js`** — Shared sync engine. Contains `runSync()`, API fetching with pagination, folder management, and `SETTINGS_DEFAULTS`. Imported by `background.js` via `importScripts()`. Not a module — uses plain globals.
- **`background.js`** — MV3 service worker. Handles `chrome.alarms` for auto-sync, listens for manual sync messages from popup, and reacts to storage changes.
- **`popup.js`** — Sends `{action: "sync"}` to background, receives `{action: "syncProgress"}` messages back. Displays stats from `chrome.storage.sync`.
- **`options.js`** — Full settings page. Renders the bookmark folder tree dynamically via `chrome.bookmarks.getTree()`. Saves to `chrome.storage.sync`.

## Key Design Decisions

- **Sync runs in the background service worker**, not the popup. This prevents sync from being killed if the popup closes.
- **Each sync clears the target folder first** (`removeChildrenOf`) then recreates everything. No incremental/deduplication logic yet.
- **Multi-tag bookmarks are duplicated** into each tag's subfolder. Untagged bookmarks go into an "Untagged" folder.
- **Bookmark folder IDs are not hardcoded** (e.g., no assuming "1" = Bookmarks Bar). The user picks the parent folder via a tree browser because IDs differ across browsers (especially Vivaldi).
- Settings stored in `chrome.storage.sync` so they persist across devices.

## Linkding API

- Auth: `Authorization: Token <token>` header
- List bookmarks: `GET /api/bookmarks/?limit=100`
- Pagination: follow the `next` URL in the response until `null`
- Response shape: `{ count, next, previous, results: [{ id, url, title, tag_names, ... }] }`

## Storage Keys

`url`, `token`, `folderName`, `parentFolderId`, `autoSync`, `autoSyncInterval`, `lastSyncTime`, `lastSyncCount`, `lastSyncTags`
