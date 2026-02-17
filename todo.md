# Linkding Sync — TODO

## Bugs

- [x] **PUT → PATCH in `updateLinkdingBookmark`** (`sync.js:307`) — PUT replaces the entire resource, so omitted fields (title, url, tags) may get wiped when sending partial updates. Switch to `method: "PATCH"` for safe partial updates.

- [x] **Variable shadowing in `createLinkdingBookmark`** (`sync.js:287`) — `const body = await resp.text()` shadows the outer `body` object. Rename to `errBody` or similar to avoid confusion.

## Improvements

- [x] **Prevent sync-triggered feedback loops** (`background.js:119-148`) — Bookmark event listeners fire when `runTwoWaySync` itself creates/removes bookmarks. Add an `isSelfModifying` flag during sync to skip unnecessary re-triggers.

- [x] **Config bookmark search is fragile** (`sync.js:92`) — Full-text search with `&limit=1` may return the wrong bookmark. Search by the unique URL (`example.com/?linkding-sync-config`) or increase the limit and filter client-side.

- [x] **`fetchConfig` doesn't return the bookmark ID** — Causes a duplicate API call in `runInitialTwoWaySync` (lines 661-669) to re-fetch the ID. Return `{ data, id }` from `fetchConfig` instead.

- [x] **Simplify `processBatch`** (`sync.js:64`) — `BATCH_SIZE` is always 1 with a 1-second delay, so the concurrency infrastructure is unused. Replace with a plain `for` loop + delay, or revisit whether the rate-limit delay is still needed.

- [x] **Incremental one-way sync** (`sync.js:158`) — Currently deletes all bookmarks and recreates them every sync. A diff-based approach would be faster and avoid visual flicker for large collections.

- [x] **Service worker retry in popup** — MV3 aggressively hibernates service workers. Add a simple wake-and-retry when `chrome.runtime.sendMessage` fails with `lastError`.

## Notes

- `chrome.storage.sync` has 8KB per-item / 100KB total limits. The URL-keyed mapping is already in `chrome.storage.local`. Keep an eye on stats/config stored in `sync` as the extension grows.
