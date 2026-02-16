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
