# Linkding Sync - Codebase Guide

This guide documents the architecture, key components, and data structures for the Linkding Sync Chrome extension.

## 1. Project Overview

**Linkding Sync** synchronizes bookmarks from a self-hosted Linkding instance into the browser's bookmark tree. It supports:
- One-way sync (Linkding -> Browser)
- Two-way sync (Linkding <-> Browser)
- Folder-based organization by tags
- Nested folders support (e.g., `Work/Project`)

## 2. Technical Stack

- **Platform**: Chrome Extension MV3 (Manifest V3)
- **Language**: Vanilla JavaScript (ES6+), HTML, CSS
- **Build System**: None. Files are loaded directly by the browser.
- **Dependencies**: None (Zero dependencies).

## 3. Architecture

The extension logic is split between the Background Service Worker and the Popup/Options UI.

```mermaid
graph TD
    subgraph UI
        Popup[popup.html / popup.js]
        Options[options.html / options.js]
    end

    subgraph Core
        BG[background.js (Service Worker)]
        Sync[sync.js (Shared Logic)]
    end

    subgraph External
        Linkding[Linkding API]
        ChromeMount[Chrome Bookmarks API]
        ChromeStore[chrome.storage]
    end

    Popup -- "Message: {action: 'sync'}" --> BG
    Options -- "Save Settings" --> ChromeStore
    BG -- "Import" --> Sync
    Popup -- "Import" --> Sync
    Sync -- "Fetch/Update" --> Linkding
    Sync -- "Read/Write" --> ChromeMount
    Sync -- "Read/Write (Mapping)" --> ChromeStore
```

### Key Files

| File | Type | Responsibility |
|------|------|----------------|
| `manifest.json` | Config | Extension configuration, permissions (`bookmarks`, `storage`, `alarms`). |
| `background.js` | Service Worker | Handles auto-sync alarms and background sync execution. Imports `sync.js`. |
| `popup.js` | UI Logic | Handles manual sync triggers and progress display. Imports `sync.js`. |
| `options.js` | UI Logic | Manages configuration (URL, Token, Folder selection). |
| `sync.js` | Shared Library | **Core Logic**. Contains all sync algorithms, API clients, and data mapping. |

## 4. Sync Logic (`sync.js`)

The sync logic is the most complex part of the application. It handles both One-Way and Two-Way synchronization.

### Data Structures

#### Settings (`chrome.storage.sync`)
Stored in `chrome.storage.sync` for cross-device availability:
- `url`: Linkding instance URL
- `token`: API Token
- `twoWayEnabled`: Boolean
- `twoWaySyncTag`: Tag to use for sync (default: `bookmark-sync`)
- `twoWaySyncFolderId`: Folder ID in Chrome bookmarks.
- `twoWayMapping`: **Crucial** - see below.

#### Two-Way Mapping (`chrome.storage.local`)
Stored in `chrome.storage.local` (too large for sync storage).
Maps a URL to its state in both systems to detect changes.

```javascript
mapping = {
  "https://example.com": {
    linkdingId: 123,       // ID in Linkding
    chromeId: "456",       // ID in Chrome Bookmarks
    title: "Example",      // Last synced title
    url: "https://example.com",
    folderPath: "Tech/News", // Relative folder path
    lastSynced: 162938492  // Timestamp
  }
}
```

### Folder Handling
- **Linkding**: Flat structure with Tags.
- **Chrome**: Hierarchical Folders.
- **Translation**: Tags are converted to folder paths.
  - Tag `bookmark-sync` -> Root folder
  - Tag `bookmark-sync/Work` -> `Work` subfolder
  - Tag `bookmark-sync/Work/Project` -> `Work/Project` subfolder

### Conflict Resolution
When modification dates conflict during a Merge:
1. **Title**: Newer modification time wins.
2. **Move/Folder**: If moved in both, **Chrome wins** (User interaction priority).

## 5. API Integration

### Linkding API
- **Auth**: `Authorization: Token <token>`
- **List**: `GET /api/bookmarks/?q=<tag>&limit=100` (Paginated)
- **Create**: `POST /api/bookmarks/`
- **Update**: `PUT /api/bookmarks/<id>/`
- **Delete**: `DELETE /api/bookmarks/<id>/`

### Chrome APIs
- `chrome.bookmarks`: Creating, moving, updating bookmarks/folders.
- `chrome.storage`: Persisting settings and sync state.
- `chrome.alarms`: Scheduling background syncs.
