// Shared sync logic used by both popup.js and background.js

const SETTINGS_DEFAULTS = {
  url: "",
  token: "",
  folderName: "Linkding",
  parentFolderId: null,
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

async function runSync(onProgress) {
  const log = onProgress || (() => {});

  const { url, token, folderName, parentFolderId } = await getSettings();
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

  // Collect tags
  const tagNames = new Set();
  let hasUntagged = false;
  for (const bm of bookmarks) {
    if (bm.tag_names && bm.tag_names.length > 0) {
      bm.tag_names.forEach((t) => tagNames.add(t));
    } else {
      hasUntagged = true;
    }
  }
  if (hasUntagged) tagNames.add("Untagged");

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
    for (const tag of tags) {
      await chrome.bookmarks.create({
        parentId: tagFolderIds[tag],
        title: bm.title || bm.url,
        url: bm.url,
      });
      created++;
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

async function createLinkdingBookmark(baseUrl, token, { url, title, tagNames }) {
  const resp = await fetch(`${baseUrl}/api/bookmarks/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      title: title || url,
      tag_names: tagNames,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Create failed ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function updateLinkdingBookmark(baseUrl, token, id, { url, title, tag_names }) {
  const resp = await fetch(`${baseUrl}/api/bookmarks/${id}/`, {
    method: "PUT",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, title, tag_names }),
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
  const log = onProgress || (() => {});
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
    for (const cbm of chromeBookmarks) {
      const tags = buildTagsForPath(twoWaySyncTag, cbm.folderPath);
      if (ldByUrl.has(cbm.url)) {
        // Already exists in Linkding — link them, update tags to include path
        const ld = ldByUrl.get(cbm.url);
        const mergedTags = [...new Set([...ld.tag_names, ...tags])];
        await updateLinkdingBookmark(baseUrl, token, ld.id, {
          url: ld.url,
          title: ld.title,
          tag_names: mergedTags,
        });
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
      if ((added + updated) % 10 === 0) {
        log("syncing", `Pushed ${added + updated} of ${chromeBookmarks.length}...`);
      }
    }
  } else if (mode === "pull") {
    log("syncing", "Pulling Linkding bookmarks to Chrome...");
    // Clear existing bookmarks and subfolders
    await removeChildrenOf(twoWaySyncFolderId);
    for (const ld of ldBookmarks) {
      const folderPath = extractFolderPath(twoWaySyncTag, ld.tag_names);
      const parentId = await ensureFolderPath(twoWaySyncFolderId, folderPath);
      const created = await chrome.bookmarks.create({
        parentId,
        title: ld.title || ld.url,
        url: ld.url,
      });
      mapping[ld.url] = {
        linkdingId: ld.id,
        chromeId: created.id,
        title: ld.title || ld.url,
        url: ld.url,
        folderPath,
        lastSynced: Date.now(),
      };
      downloaded++;
      if (downloaded % 10 === 0) {
        log("syncing", `Pulled ${downloaded} of ${ldBookmarks.length}...`);
      }
    }
  } else if (mode === "merge") {
    log("syncing", "Merging bookmarks...");
    const allUrls = new Set([...ldByUrl.keys(), ...chromeByUrl.keys()]);

    for (const url of allUrls) {
      const inLd = ldByUrl.has(url);
      const inChrome = chromeByUrl.has(url);

      if (inLd && inChrome) {
        // In both — link them, keep newer title, sync folder path
        const ld = ldByUrl.get(url);
        const cbm = chromeByUrl.get(url);
        const ldDate = ld.date_modified ? new Date(ld.date_modified).getTime() : 0;
        const chromeDate = cbm.dateAdded || 0;
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

  return { added, updated, downloaded, total: Object.keys(mapping).length };
}

async function runTwoWaySync(onProgress) {
  const log = onProgress || (() => {});
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
      await deleteLinkdingBookmark(baseUrl, token, entry.linkdingId);
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
