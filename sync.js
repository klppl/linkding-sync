// Shared sync logic used by both popup.js and background.js

const SETTINGS_DEFAULTS = {
  url: "",
  token: "",
  folderName: "Linkding",
  parentFolderId: null,
  oneWayEnabled: true,
  autoSync: false,
  autoSyncInterval: 60,
  lastSyncTime: null,
  lastSyncCount: null,
  lastSyncTags: null,
  twoWayEnabled: false,
  twoWaySyncTag: "bookmark-sync",
  twoWaySyncFolderId: null,
  twoWayInitialSyncDone: false,
  twoWayLastSyncTime: null,
  excludedTags: "bookmark-sync", // Comma-separated list of tags to exclude from one-way sync
};

async function getSettings() {
  return chrome.storage.sync.get(SETTINGS_DEFAULTS);
}

async function getOrCreateFolder(name, parentId) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const existing = children.find((n) => !n.url && n.title === name);
  if (existing) return existing.id;
  const created = await chrome.bookmarks.create({ parentId, title: name });
  return created.id;
}

async function fetchAllBookmarks(baseUrl, token) {
  const all = [];
  let url = `${baseUrl}/api/bookmarks/?limit=100`;
  while (url) {
    const resp = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`API ${resp.status}: ${resp.statusText} ${body}`);
    }
    const data = await resp.json();
    all.push(...data.results);
    url = data.next;
  }
  return all;
}

async function removeChildrenOf(folderId) {
  const children = await chrome.bookmarks.getChildren(folderId);
  for (const child of children) {
    if (child.url) {
      await chrome.bookmarks.remove(child.id);
    } else {
      await chrome.bookmarks.removeTree(child.id);
    }
  }
}

// Helper for batch processing with concurrency limit
async function processBatch(items, limit, fn) {
  const results = [];
  const executing = [];

  for (const item of items) {
    // Wrap fn(item) in try-catch to prevent one failure from stopping all
    const p = Promise.resolve().then(async () => {
      try {
        return await fn(item);
      } catch (e) {
        console.error("Batch item failed", e);
        return null;
      }
    });
    results.push(p);

    // Add small delay to avoid server rate limits (500 errors)
    // Increased to 1000ms (1s) because 200ms was still getting blocked
    await new Promise(r => setTimeout(r, 1000));

    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

// Config Bookmark Helpers
const CONFIG_TITLE = "Linkding Sync Config";

async function fetchConfig(baseUrl, token) {
  // Search for the config bookmark
  const searchUrl = `${baseUrl.replace(/\/$/, "")}/api/bookmarks/?q=${encodeURIComponent(CONFIG_TITLE)}&limit=1`;
  try {
    const response = await fetch(searchUrl, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const configBm = data.results.find(bm => bm.title === CONFIG_TITLE);
    if (!configBm) return null;

    try {
      return JSON.parse(configBm.description);
    } catch {
      return null; // Invalid JSON or empty
    }
  } catch (e) {
    console.error("Failed to fetch config", e);
    return null;
  }
}

async function saveConfig(baseUrl, token, orderData, existingId = null) {
  const description = JSON.stringify(orderData);

  if (existingId) {
    // Update existing
    try {
      await updateLinkdingBookmark(baseUrl, token, existingId, { description });
    } catch (e) {
      console.error("Failed to update config bookmark", e);
    }
  } else {
    // Create new
    // Use a very simple URL to avoid validation errors
    try {
      await createLinkdingBookmark(baseUrl, token, {
        url: "http://example.com/?linkding-sync-config",
        title: CONFIG_TITLE,
        description,
        tagNames: ["bookmark-sync-config"],
      });
    } catch (e) {
      console.error("Failed to create config bookmark", e);
      throw e; // Rethrow to let caller know
    }
  }
}

async function runSync(onProgress) {
  const log = onProgress || (() => { });

  const { url, token, folderName, parentFolderId, excludedTags, twoWayEnabled, twoWaySyncTag } = await getSettings();
  if (!url || !token) throw new Error("Missing URL or API token.");
  if (!parentFolderId) throw new Error("No bookmark folder selected.");

  // Verify parent exists
  try {
    await chrome.bookmarks.get(parentFolderId);
  } catch {
    throw new Error("Selected parent folder no longer exists. Reconfigure in Options.");
  }

  log("preparing", "Preparing folders...");
  const rootFolderId = await getOrCreateFolder(folderName, parentFolderId);

  // Clear previous bookmarks for a clean sync
  await removeChildrenOf(rootFolderId);

  log("fetching", "Fetching from Linkding...");
  const bookmarks = await fetchAllBookmarks(url, token);
  const config = await fetchConfig(url, token);

  // Apply Sort Order from Config
  if (config && Array.isArray(config.order)) {
    const orderMap = new Map();
    config.order.forEach((u, i) => orderMap.set(u, i));

    bookmarks.sort((a, b) => {
      const idxA = orderMap.has(a.url) ? orderMap.get(a.url) : Number.MAX_SAFE_INTEGER;
      const idxB = orderMap.has(b.url) ? orderMap.get(b.url) : Number.MAX_SAFE_INTEGER;
      return idxA - idxB;
    });
  }

  // Collect tags
  const tagNames = new Set();
  const excludedTagsList = excludedTags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Automatically exclude the two-way sync tag to prevent duplication
  if (twoWayEnabled && twoWaySyncTag && !excludedTagsList.includes(twoWaySyncTag)) {
    excludedTagsList.push(twoWaySyncTag);
  }

  let hasUntagged = false;
  for (const bm of bookmarks) {
    if (bm.tag_names && bm.tag_names.length > 0) {
      bm.tag_names.forEach((t) => {
        if (!excludedTagsList.includes(t)) {
          tagNames.add(t);
        }
      });
    } else {
      hasUntagged = true;
    }
  }
  // Only add Untagged if it's not explicitly excluded (though rare use case)
  if (hasUntagged && !excludedTagsList.includes("Untagged")) {
    tagNames.add("Untagged");
  }

  log("folders", `Creating ${tagNames.size} tag folders...`);
  const tagFolderIds = {};
  for (const tag of tagNames) {
    tagFolderIds[tag] = await getOrCreateFolder(tag, rootFolderId);
  }

  log("saving", `Saving ${bookmarks.length} bookmarks...`);
  let created = 0;
  for (const bm of bookmarks) {
    const tags =
      bm.tag_names && bm.tag_names.length > 0 ? bm.tag_names : ["Untagged"];

    // Filter tags for this bookmark
    const validTags = tags.filter(t => !excludedTagsList.includes(t));

    for (const tag of validTags) {
      if (tagFolderIds[tag]) { // Should exist if we did our job above
        await chrome.bookmarks.create({
          parentId: tagFolderIds[tag],
          title: bm.title || bm.url,
          url: bm.url,
        });
        created++;
      }
    }
    if (created % 100 === 0) {
      log("saving", `Saved ${created} entries...`);
    }
  }

  // Persist last sync info
  await chrome.storage.sync.set({
    lastSyncTime: Date.now(),
    lastSyncCount: bookmarks.length,
    lastSyncTags: tagNames.size,
  });

  return { bookmarks: bookmarks.length, tags: tagNames.size, entries: created };
}

// ===================== Two-Way Sync =====================

async function getMapping() {
  const { twoWayMapping } = await chrome.storage.local.get({ twoWayMapping: {} });
  return twoWayMapping;
}

async function setMapping(mapping) {
  await chrome.storage.local.set({ twoWayMapping: mapping });
}

async function fetchBookmarksWithTag(baseUrl, token, tag) {
  const all = [];
  let url = `${baseUrl}/api/bookmarks/?q=%23${encodeURIComponent(tag)}&limit=100`;
  while (url) {
    const resp = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`API ${resp.status}: ${resp.statusText} ${body}`);
    }
    const data = await resp.json();
    all.push(...data.results);
    url = data.next;
  }
  // Filter to only bookmarks that actually have the exact tag
  return all.filter((bm) => bm.tag_names && bm.tag_names.includes(tag));
}

async function createLinkdingBookmark(baseUrl, token, { url, title, description, tagNames }) {
  const resp = await fetch(`${baseUrl}/api/bookmarks/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      title: title || url,
      description,
      tag_names: tagNames,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    // Try to parse JSON error to be more helpful
    try {
      const errObj = JSON.parse(body);
      throw new Error(`Create failed ${resp.status}: ${JSON.stringify(errObj)}`);
    } catch {
      throw new Error(`Create failed ${resp.status}: ${body}`);
    }
  }
  return resp.json();
}

async function updateLinkdingBookmark(baseUrl, token, id, { url, title, description, tag_names }) {
  const bodyData = {};
  if (url) bodyData.url = url;
  if (title) bodyData.title = title;
  if (description !== undefined) bodyData.description = description;
  if (tag_names) bodyData.tag_names = tag_names;

  const resp = await fetch(`${baseUrl}/api/bookmarks/${id}/`, {
    method: "PUT", // Linkding API supports partial updates via PATCH usually? Or PUT requires all fields?
    // Documentation says PUT updates the bookmark. 
    // If we use PUT we might need all fields. Let's use PATCH if supported, or assume PUT works with what we send.
    // Actually, usually PUT replaces the resource. 
    // Safest to just send what we have. 
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyData),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Update failed ${resp.status}: ${body}`);
  }
  return resp.json();
}


async function deleteLinkdingBookmark(baseUrl, token, id) {
  const resp = await fetch(`${baseUrl}/api/bookmarks/${id}/`, {
    method: "DELETE",
    headers: { Authorization: `Token ${token}` },
  });
  if (!resp.ok && resp.status !== 404) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Delete failed ${resp.status}: ${body}`);
  }
}

// Recursively collect all bookmarks under a folder with their relative folder path.
// Returns array of { id, url, title, dateAdded, folderPath } where folderPath is
// "" for root-level bookmarks or "Subfolder/Nested" for nested ones.
async function getChromeBookmarksRecursive(folderId, prefix) {
  const results = [];
  const children = await chrome.bookmarks.getChildren(folderId);
  for (const child of children) {
    if (child.url) {
      results.push({
        id: child.id,
        url: child.url,
        title: child.title,
        dateAdded: child.dateAdded,
        folderPath: prefix,
      });
    } else {
      // It's a subfolder — recurse
      const subPath = prefix ? `${prefix}/${child.title}` : child.title;
      const sub = await getChromeBookmarksRecursive(child.id, subPath);
      results.push(...sub);
    }
  }
  return results;
}

// Build the tag list for a bookmark given its folder path.
// Root-level bookmarks: [syncTag]
// Nested bookmarks: [syncTag, "syncTag/Folder/Sub"]
function buildTagsForPath(syncTag, folderPath) {
  if (!folderPath) return [syncTag];
  return [syncTag, `${syncTag}/${folderPath}`];
}

// Extract folder path from a Linkding bookmark's tags relative to the sync tag.
// Looks for the most specific tag matching "syncTag/..." pattern.
function extractFolderPath(syncTag, tagNames) {
  const prefix = syncTag + "/";
  let best = "";
  for (const t of tagNames) {
    if (t.startsWith(prefix) && t.length > best.length) {
      best = t;
    }
  }
  return best ? best.slice(prefix.length) : "";
}

// Ensure a nested folder path exists under rootFolderId, creating folders as needed.
// e.g. ensureFolderPath(rootId, "Work/Projects") creates Work/ then Projects/ inside it.
// Returns the ID of the deepest folder.
async function ensureFolderPath(rootFolderId, folderPath) {
  if (!folderPath) return rootFolderId;
  const parts = folderPath.split("/");
  let currentId = rootFolderId;
  for (const part of parts) {
    currentId = await getOrCreateFolder(part, currentId);
  }
  return currentId;
}

// Check if a bookmark node is anywhere inside the two-way sync folder tree
async function isInsideTwoWayFolder(nodeId, twoWaySyncFolderId) {
  let currentId = nodeId;
  while (currentId) {
    if (currentId === twoWaySyncFolderId) return true;
    try {
      const [node] = await chrome.bookmarks.get(currentId);
      currentId = node.parentId;
    } catch {
      return false;
    }
  }
  return false;
}

async function runInitialTwoWaySync(mode, onProgress) {
  const log = onProgress || (() => { });
  const settings = await getSettings();
  const { url: baseUrl, token, twoWaySyncTag, twoWaySyncFolderId } = settings;

  if (!baseUrl || !token) throw new Error("Missing URL or API token.");
  if (!twoWaySyncFolderId) throw new Error("No two-way sync folder selected.");

  // Verify folder exists
  try {
    await chrome.bookmarks.get(twoWaySyncFolderId);
  } catch {
    throw new Error("Selected two-way sync folder no longer exists.");
  }

  log("fetching", "Fetching tagged bookmarks from Linkding...");
  const ldBookmarks = await fetchBookmarksWithTag(baseUrl, token, twoWaySyncTag);

  log("reading", "Reading Chrome bookmarks (including subfolders)...");
  const chromeBookmarks = await getChromeBookmarksRecursive(twoWaySyncFolderId, "");

  // Build URL indexes
  const ldByUrl = new Map();
  for (const bm of ldBookmarks) ldByUrl.set(bm.url, bm);
  const chromeByUrl = new Map();
  for (const bm of chromeBookmarks) chromeByUrl.set(bm.url, bm);

  const mapping = {};
  let added = 0, updated = 0, downloaded = 0;

  if (mode === "push") {
    log("syncing", "Pushing Chrome bookmarks to Linkding...");

    // Process in batches
    // Reduced from 5 to 2 to avoid Cloudflare/rate-limit blocking (500 errors)
    // Reduced to 1 (Serial) because 2 was still blocked
    const BATCH_SIZE = 1;
    let processed = 0;

    await processBatch(chromeBookmarks, BATCH_SIZE, async (cbm) => {
      const tags = buildTagsForPath(twoWaySyncTag, cbm.folderPath);

      if (ldByUrl.has(cbm.url)) {
        // Link exists — just update mappings
        const ld = ldByUrl.get(cbm.url);
        // We might want to sync tags here too? The original code updated tags in Linkding.
        const mergedTags = [...new Set([...ld.tag_names, ...tags])];
        if (mergedTags.length !== ld.tag_names.length || !mergedTags.every(t => ld.tag_names.includes(t))) {
          await updateLinkdingBookmark(baseUrl, token, ld.id, {
            url: ld.url,
            title: ld.title,
            tag_names: mergedTags,
          });
        }

        mapping[cbm.url] = {
          linkdingId: ld.id,
          chromeId: cbm.id,
          title: cbm.title,
          url: cbm.url,
          folderPath: cbm.folderPath,
          lastSynced: Date.now(),
        };
        updated++;
      } else {
        // Upload to Linkding
        const created = await createLinkdingBookmark(baseUrl, token, {
          url: cbm.url,
          title: cbm.title,
          tagNames: tags,
        });
        mapping[cbm.url] = {
          linkdingId: created.id,
          chromeId: cbm.id,
          title: cbm.title,
          url: cbm.url,
          folderPath: cbm.folderPath,
          lastSynced: Date.now(),
        };
        added++;
      }
      processed++;
      if (processed % 10 === 0) {
        log("syncing", `Pushed ${processed} of ${chromeBookmarks.length}...`);
      }
    });
  } else if (mode === "pull") {
    log("syncing", "Pulling Linkding bookmarks to Chrome...");

    // Fetch config and sort ldBookmarks if order exists
    const config = await fetchConfig(baseUrl, token);
    if (config && Array.isArray(config.order)) {
      const orderMap = new Map();
      config.order.forEach((u, i) => orderMap.set(u, i));
      ldBookmarks.sort((a, b) => {
        const idxA = orderMap.has(a.url) ? orderMap.get(a.url) : Number.MAX_SAFE_INTEGER;
        const idxB = orderMap.has(b.url) ? orderMap.get(b.url) : Number.MAX_SAFE_INTEGER;
        return idxA - idxB;
      });
    }

    // Clear existing bookmarks and subfolders
    await removeChildrenOf(twoWaySyncFolderId);

    const BATCH_SIZE = 1;
    let processed = 0;

    await processBatch(ldBookmarks, BATCH_SIZE, async (ld) => {
      const folderPath = extractFolderPath(twoWaySyncTag, ld.tag_names);
      // Ensure folder path exists (needs careful handling with concurrency - here ensureFolderPath does minimal work if exists)
      // Best to ensure all folder paths first? But that's complex. With small batch size, collisions are rare but possible.
      // JS bookmark creation is async message passing.
      // To be safe against race conditions on folder creation, we could pre-create all folders.
      // But let's try direct. ensureFolderPath handles race? No, it doesn't really.
      // Let's use a mutex-like approach or just pre-create.

      const parentId = await ensureFolderPath(twoWaySyncFolderId, folderPath);

      const title = ld.title || ld.url;
      const created = await chrome.bookmarks.create({
        parentId,
        title: title,
        url: ld.url,
      });
      mapping[ld.url] = {
        linkdingId: ld.id,
        chromeId: created.id,
        title: title,
        url: ld.url,
        folderPath,
        lastSynced: Date.now(),
      };
      processed++;
      downloaded++;
      if (processed % 10 === 0) {
        log("syncing", `Pulled ${processed} of ${ldBookmarks.length}...`);
      }
    });
  } else if (mode === "merge") {
    log("syncing", "Merging bookmarks...");
    // Sort URLs based on config to ensure creation/processing order mimics desired order
    // (This helps mostly with creation of new items)
    let sortedUrls = [...new Set([...ldByUrl.keys(), ...chromeByUrl.keys()])];

    // Fetch config for sorting and later comparison
    const config = await fetchConfig(baseUrl, token);
    const existingOrder = config && Array.isArray(config.order) ? config.order : [];

    if (existingOrder.length > 0) {
      const orderMap = new Map();
      existingOrder.forEach((u, i) => orderMap.set(u, i));
      sortedUrls.sort((a, b) => {
        const idxA = orderMap.has(a) ? orderMap.get(a) : Number.MAX_SAFE_INTEGER;
        const idxB = orderMap.has(b) ? orderMap.get(b) : Number.MAX_SAFE_INTEGER;
        return idxA - idxB;
      });
    }

    for (const url of sortedUrls) {
      const inLd = ldByUrl.has(url);
      const inChrome = chromeByUrl.has(url);

      if (inLd && inChrome) {
        // In both — link them, keep newer title, sync folder path
        const ld = ldByUrl.get(url);
        const cbm = chromeByUrl.get(url);
        const ldDate = ld.date_modified ? new Date(ld.date_modified).getTime() : 0;
        const chromeDate = cbm.dateAdded || 0;

        // If Linkding is newer, use its title
        const title = ldDate > chromeDate ? (ld.title || ld.url) : cbm.title;

        if (title !== cbm.title) {
          await chrome.bookmarks.update(cbm.id, { title });
        }
        // Update Linkding tags to include folder path from Chrome
        const tags = buildTagsForPath(twoWaySyncTag, cbm.folderPath);
        const mergedTags = [...new Set([...ld.tag_names, ...tags])];
        if (mergedTags.length !== ld.tag_names.length || !mergedTags.every(t => ld.tag_names.includes(t))) {
          await updateLinkdingBookmark(baseUrl, token, ld.id, {
            url: ld.url,
            title: title,
            tag_names: mergedTags,
          });
        }
        mapping[url] = {
          linkdingId: ld.id,
          chromeId: cbm.id,
          title,
          url,
          folderPath: cbm.folderPath,
          lastSynced: Date.now(),
        };
        updated++;
      } else if (inChrome && !inLd) {
        // Only in Chrome — upload to Linkding with folder path tag
        const cbm = chromeByUrl.get(url);
        const tags = buildTagsForPath(twoWaySyncTag, cbm.folderPath);
        const created = await createLinkdingBookmark(baseUrl, token, {
          url: cbm.url,
          title: cbm.title,
          tagNames: tags,
        });
        mapping[url] = {
          linkdingId: created.id,
          chromeId: cbm.id,
          title: cbm.title,
          url,
          folderPath: cbm.folderPath,
          lastSynced: Date.now(),
        };
        added++;
      } else if (inLd && !inChrome) {
        // Only in Linkding — download to Chrome in correct subfolder
        const ld = ldByUrl.get(url);
        const folderPath = extractFolderPath(twoWaySyncTag, ld.tag_names);
        const parentId = await ensureFolderPath(twoWaySyncFolderId, folderPath);
        const created = await chrome.bookmarks.create({
          parentId,
          title: ld.title || ld.url,
          url: ld.url,
        });
        mapping[url] = {
          linkdingId: ld.id,
          chromeId: created.id,
          title: ld.title || ld.url,
          url,
          folderPath,
          lastSynced: Date.now(),
        };
        downloaded++;
      }
    }
  }

  await setMapping(mapping);
  await chrome.storage.sync.set({
    twoWayInitialSyncDone: true,
    twoWayLastSyncTime: Date.now(),
  });

  // Force-create config bookmark so it exists immediately
  let configError = null;
  try {
    log("syncing", "Creating/Updating Linkding Sync Config...");
    const finalChromeBookmarks = await getChromeBookmarksRecursive(twoWaySyncFolderId, "");
    const newOrder = finalChromeBookmarks.map(bm => bm.url);

    // Check if it already exists
    const searchUrl = `${baseUrl.replace(/\/$/, "")}/api/bookmarks/?q=${encodeURIComponent(CONFIG_TITLE)}&limit=1`;
    const response = await fetch(searchUrl, { headers: { Authorization: `Token ${token}` } });
    let configId = null;

    if (response.ok) {
      const data = await response.json();
      const existing = data.results.find(bm => bm.title === CONFIG_TITLE);
      if (existing) {
        configId = existing.id;
        log("syncing", `Found existing config (ID: ${configId}). Updating...`);
      } else {
        log("syncing", "No existing config found. Creating new...");
      }
    } else {
      console.error("Failed to search for config bookmark", response.status);
    }

    await saveConfig(baseUrl, token, { order: newOrder }, configId);
    log("syncing", "Config bookmark operation complete.");
  } catch (e) {
    console.error("Failed to create/update initial config", e);
    log("syncing", "Error creating config bookmark: " + e.message);
    configError = e.message;
  }

  return { added, updated, downloaded, total: Object.keys(mapping).length, configError };
}

async function runTwoWaySync(onProgress) {
  const log = onProgress || (() => { });
  const settings = await getSettings();
  const { url: baseUrl, token, twoWayEnabled, twoWaySyncTag, twoWaySyncFolderId, twoWayInitialSyncDone } = settings;

  if (!twoWayEnabled) throw new Error("Two-way sync is not enabled.");
  if (!baseUrl || !token) throw new Error("Missing URL or API token.");
  if (!twoWaySyncFolderId) throw new Error("No two-way sync folder selected.");
  if (!twoWayInitialSyncDone) throw new Error("Initial sync has not been completed yet.");

  // Verify folder exists
  try {
    await chrome.bookmarks.get(twoWaySyncFolderId);
  } catch {
    throw new Error("Selected two-way sync folder no longer exists.");
  }

  log("fetching", "Fetching tagged bookmarks from Linkding...");
  const ldBookmarks = await fetchBookmarksWithTag(baseUrl, token, twoWaySyncTag);

  log("reading", "Reading Chrome bookmarks (including subfolders)...");
  const chromeBookmarks = await getChromeBookmarksRecursive(twoWaySyncFolderId, "");

  const mapping = await getMapping();

  // Build URL indexes
  const ldByUrl = new Map();
  for (const bm of ldBookmarks) ldByUrl.set(bm.url, bm);
  const chromeByUrl = new Map();
  for (const bm of chromeBookmarks) chromeByUrl.set(bm.url, bm);

  const newMapping = {};
  let added = 0, removed = 0, updated = 0;

  log("syncing", "Comparing bookmarks...");

  // 1. URLs in Chrome but not in mapping → new in Chrome → POST to Linkding
  for (const cbm of chromeBookmarks) {
    if (!mapping[cbm.url]) {
      const tags = buildTagsForPath(twoWaySyncTag, cbm.folderPath);
      if (!ldByUrl.has(cbm.url)) {
        const created = await createLinkdingBookmark(baseUrl, token, {
          url: cbm.url,
          title: cbm.title,
          tagNames: tags,
        });
        newMapping[cbm.url] = {
          linkdingId: created.id,
          chromeId: cbm.id,
          title: cbm.title,
          url: cbm.url,
          folderPath: cbm.folderPath,
          lastSynced: Date.now(),
        };
        added++;
      } else {
        // URL already exists in Linkding — link them, update path tags
        const ld = ldByUrl.get(cbm.url);
        const mergedTags = [...new Set([...ld.tag_names, ...tags])];
        if (mergedTags.length !== ld.tag_names.length || !mergedTags.every(t => ld.tag_names.includes(t))) {
          await updateLinkdingBookmark(baseUrl, token, ld.id, {
            url: ld.url,
            title: ld.title,
            tag_names: mergedTags,
          });
        }
        newMapping[cbm.url] = {
          linkdingId: ld.id,
          chromeId: cbm.id,
          title: cbm.title,
          url: cbm.url,
          folderPath: cbm.folderPath,
          lastSynced: Date.now(),
        };
      }
    }
  }

  // 2. URLs in Linkding but not in mapping → new in Linkding → create in Chrome
  for (const ld of ldBookmarks) {
    if (!mapping[ld.url] && !chromeByUrl.has(ld.url)) {
      const folderPath = extractFolderPath(twoWaySyncTag, ld.tag_names);
      const parentId = await ensureFolderPath(twoWaySyncFolderId, folderPath);
      const created = await chrome.bookmarks.create({
        parentId,
        title: ld.title || ld.url,
        url: ld.url,
      });
      newMapping[ld.url] = {
        linkdingId: ld.id,
        chromeId: created.id,
        title: ld.title || ld.url,
        url: ld.url,
        folderPath,
        lastSynced: Date.now(),
      };
      added++;
    }
  }

  // 3. Process mapped entries
  for (const [url, entry] of Object.entries(mapping)) {
    const inChrome = chromeByUrl.has(url);
    const inLd = ldByUrl.has(url);

    if (!inChrome && !inLd) {
      removed++;
      continue;
    }

    if (!inChrome && inLd) {
      // Deleted from Chrome → delete from Linkding
      // Use the ID from the fresh fetch (ld.id), NOT the potentially stale mapping ID
      const ld = ldByUrl.get(url);
      await deleteLinkdingBookmark(baseUrl, token, ld.id);
      removed++;
      continue;
    }

    if (inChrome && !inLd) {
      // Deleted from Linkding → remove from Chrome
      try {
        await chrome.bookmarks.remove(entry.chromeId);
      } catch {
        // Already gone
      }
      removed++;
      continue;
    }

    // Both exist — check for title and folder path changes
    const cbm = chromeByUrl.get(url);
    const ld = ldByUrl.get(url);
    const chromeTitle = cbm.title;
    const ldTitle = ld.title || ld.url;
    const chromeFolderPath = cbm.folderPath;
    const ldFolderPath = extractFolderPath(twoWaySyncTag, ld.tag_names);
    const mappedFolderPath = entry.folderPath || "";

    let needsLdUpdate = false;
    let needsChromeUpdate = false;
    let finalTitle = entry.title;
    let finalFolderPath = mappedFolderPath;

    // Title changes
    // If Chrome changed, it wins. If Linkding changed, it wins.
    // We compare against the *synced* title (entry.title)
    if (chromeTitle !== entry.title && ldTitle === entry.title) {
      finalTitle = chromeTitle;
      needsLdUpdate = true;
    } else if (ldTitle !== entry.title && chromeTitle === entry.title) {
      finalTitle = ldTitle;
      needsChromeUpdate = true;
    } else if (ldTitle !== entry.title && chromeTitle !== entry.title) {
      const ldDate = ld.date_modified ? new Date(ld.date_modified).getTime() : 0;
      const mappedTime = entry.lastSynced || 0;
      if (ldDate > mappedTime) {
        finalTitle = ldTitle;
        needsChromeUpdate = true;
      } else {
        finalTitle = chromeTitle;
        needsLdUpdate = true;
      }
    }

    // Folder path changes
    if (chromeFolderPath !== mappedFolderPath && ldFolderPath === mappedFolderPath) {
      // Moved in Chrome → update Linkding tags
      finalFolderPath = chromeFolderPath;
      needsLdUpdate = true;
    } else if (ldFolderPath !== mappedFolderPath && chromeFolderPath === mappedFolderPath) {
      // Moved in Linkding → move in Chrome
      finalFolderPath = ldFolderPath;
      needsChromeUpdate = true;
    } else if (ldFolderPath !== mappedFolderPath && chromeFolderPath !== mappedFolderPath) {
      // Both moved — prefer Chrome (user is physically interacting with browser)
      finalFolderPath = chromeFolderPath;
      needsLdUpdate = true;
    }

    if (needsLdUpdate) {
      // Update Linkding: replace old path tag with new one, keep other tags
      const pathPrefix = twoWaySyncTag + "/";
      const otherTags = ld.tag_names.filter(t => t !== twoWaySyncTag && !t.startsWith(pathPrefix));
      const newTags = [...buildTagsForPath(twoWaySyncTag, finalFolderPath), ...otherTags];
      await updateLinkdingBookmark(baseUrl, token, ld.id, {
        url: ld.url,
        title: finalTitle,
        tag_names: newTags,
      });
      updated++;
    }

    if (needsChromeUpdate) {
      // Update Chrome title
      if (finalTitle !== chromeTitle) {
        await chrome.bookmarks.update(cbm.id, { title: finalTitle });
      }
      // Move bookmark if folder changed
      if (finalFolderPath !== chromeFolderPath) {
        const newParentId = await ensureFolderPath(twoWaySyncFolderId, finalFolderPath);
        await chrome.bookmarks.move(cbm.id, { parentId: newParentId });
      }
      updated++;
    }

    newMapping[url] = {
      linkdingId: ld.id,
      chromeId: cbm.id,
      title: finalTitle,
      url,
      folderPath: finalFolderPath,
      lastSynced: Date.now(),
    };

    if (!needsLdUpdate && !needsChromeUpdate) {
      // No changes — preserve mapping but update IDs
      newMapping[url] = {
        ...entry,
        chromeId: cbm.id,
        linkdingId: ld.id,
        folderPath: chromeFolderPath,
      };
    }
  }

  await setMapping(newMapping);
  await chrome.storage.sync.set({
    twoWayLastSyncTime: Date.now(),
  });

  return { added, removed, updated, total: Object.keys(newMapping).length };
}
