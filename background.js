importScripts("sync.js");

const ALARM_NAME = "linkding-auto-sync";

// Sync Manager to handle concurrency and queuing
const SyncManager = {
  isSyncing: false,
  queuedTwoWay: false,
  debounceTimer: null,

  // Run a sync operation ensuring mutual exclusion
  async run(type, func, ...args) {
    if (this.isSyncing) {
      if (type === 'twoWay') {
        this.queuedTwoWay = true;
        console.log("[Linkding] Sync already running. Queued two-way sync.");
      } else {
        console.log("[Linkding] Sync already running. Ignoring manual request.");
        throw new Error("Sync is already in progress.");
      }
      return;
    }

    this.isSyncing = true;
    try {
      return await func(...args);
    } finally {
      this.isSyncing = false;
      this.checkQueue();
    }
  },

  // Check if a two-way sync was queued while we were busy
  checkQueue() {
    if (this.queuedTwoWay) {
      this.queuedTwoWay = false;
      console.log("[Linkding] Processing queued two-way sync...");
      // Run the queued sync immediately
      this.run('twoWay', runTwoWaySync, (phase, msg) => console.log(`[Linkding] ${msg}`));
    }
  },

  // Handle debounced two-way sync requests
  requestDebouncedTwoWaySync() {
    // Clear existing timer
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    // If we are already syncing, we still want to debounce the *request* to queue it.
    this.debounceTimer = setTimeout(async () => {
      const settings = await getSettings();
      if (!settings.twoWayEnabled || !settings.twoWayInitialSyncDone) return;

      if (this.isSyncing) {
        this.queuedTwoWay = true;
        console.log("[Linkding] Bookmark change detected but sync busy. Queued.");
      } else {
        console.log("[Linkding] Bookmark change detected, running two-way sync...");
        this.run('twoWay', runTwoWaySync, (phase, msg) => console.log(`[Linkding] ${msg}`))
          .then((result) => {
            if (result) console.log(`[Linkding] Two-way sync done: +${result.added} -${result.removed} ~${result.updated}`);
          })
          .catch((err) => console.error("[Linkding] Two-way sync error:", err));
      }
    }, 2000);
  }
};

// Set up or tear down the alarm based on settings
async function updateAlarm() {
  const { autoSync, autoSyncInterval } = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (autoSync) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: autoSyncInterval });
    console.log(`[Linkding] Auto-sync alarm set: every ${autoSyncInterval} min`);
  } else {
    console.log("[Linkding] Auto-sync disabled");
  }
}

// Run sync when alarm fires
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  console.log("[Linkding] Auto-sync triggered");

  const settings = await getSettings();

  // Run one-way sync if enabled
  if (settings.oneWayEnabled) {
    try {
      // Use SyncManager to run one-way sync
      await SyncManager.run('oneWay', runSync, (phase, msg) => console.log(`[Linkding] ${msg}`));
      console.log(`[Linkding] Auto-sync done`);
    } catch (err) {
      console.error("[Linkding] Auto-sync error:", err);
    }
  }

  // Run two-way sync if enabled
  if (settings.twoWayEnabled && settings.twoWayInitialSyncDone) {
    try {
      console.log("[Linkding] Auto two-way sync triggered");
      // Use SyncManager
      const result = await SyncManager.run('twoWay', runTwoWaySync, (phase, msg) => console.log(`[Linkding] ${msg}`));
      if (result) {
        console.log(`[Linkding] Auto two-way sync done: +${result.added} -${result.removed} ~${result.updated}`);
      }
    } catch (err) {
      console.error("[Linkding] Auto two-way sync error:", err);
    }
  }
});

// Listen for settings changes to update alarm
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.autoSync || changes.autoSyncInterval) {
    updateAlarm();
  }
});

// Listen for manual sync requests from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "sync") {
    SyncManager.run('oneWay', runSync, (phase, text) => {
      chrome.runtime.sendMessage({ action: "syncProgress", phase, text }).catch(() => {});
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === "twoWayInitialSync") {
    SyncManager.run('twoWay', runInitialTwoWaySync, msg.mode, (phase, text) => {
      chrome.runtime.sendMessage({ action: "twoWayProgress", phase, text }).catch(() => {});
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === "twoWaySync") {
    SyncManager.run('twoWay', runTwoWaySync, (phase, text) => {
      chrome.runtime.sendMessage({ action: "twoWayProgress", phase, text }).catch(() => {});
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ===================== Two-Way Bookmark Listeners =====================

// Check if a folder ID is inside the two-way sync folder tree (walks up parents)
async function isInsideTwoWaySyncFolder(folderId) {
  try {
    const settings = await getSettings();
    if (!settings.twoWayEnabled || !settings.twoWaySyncFolderId) return false;
    return await isInsideTwoWayFolder(folderId, settings.twoWaySyncFolderId);
  } catch {
    return false;
  }
}

chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (bookmark.url && await isInsideTwoWaySyncFolder(bookmark.parentId)) {
    SyncManager.requestDebouncedTwoWaySync();
  }
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  if (await isInsideTwoWaySyncFolder(removeInfo.parentId)) {
    SyncManager.requestDebouncedTwoWaySync();
  }
});

chrome.bookmarks.onChanged.addListener(async (id) => {
  try {
    const [node] = await chrome.bookmarks.get(id);
    if (await isInsideTwoWaySyncFolder(node.parentId)) {
      SyncManager.requestDebouncedTwoWaySync();
    }
  } catch {
    // bookmark gone
  }
});

chrome.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  const oldInside = await isInsideTwoWaySyncFolder(moveInfo.oldParentId);
  const newInside = await isInsideTwoWaySyncFolder(moveInfo.parentId);
  if (oldInside || newInside) {
    SyncManager.requestDebouncedTwoWaySync();
  }
});

// Initialize alarm on install/startup
chrome.runtime.onInstalled.addListener(() => updateAlarm());
chrome.runtime.onStartup.addListener(() => updateAlarm());
