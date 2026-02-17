importScripts("sync.js");

const ALARM_NAME = "linkding-auto-sync";

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

  isSelfModifying = true;
  try {
    const settings = await getSettings();

    // Run one-way sync if enabled
    if (settings.oneWayEnabled) {
      try {
        const result = await runSync((phase, msg) => console.log(`[Linkding] ${msg}`));
        console.log(`[Linkding] Auto-sync done: ${result.bookmarks} bookmarks, ${result.tags} tags`);
      } catch (err) {
        console.error("[Linkding] Auto-sync error:", err);
      }
    }

    // Run two-way sync if enabled
    if (settings.twoWayEnabled && settings.twoWayInitialSyncDone) {
      try {
        console.log("[Linkding] Auto two-way sync triggered");
        const result = await runTwoWaySync((phase, msg) => console.log(`[Linkding] ${msg}`));
        console.log(`[Linkding] Auto two-way sync done: +${result.added} -${result.removed} ~${result.updated}`);
      } catch (err) {
        console.error("[Linkding] Auto two-way sync error:", err);
      }
    }
  } finally {
    isSelfModifying = false;
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
    isSelfModifying = true;
    runSync((phase, text) => {
      chrome.runtime.sendMessage({ action: "syncProgress", phase, text }).catch(() => {});
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
      .finally(() => { isSelfModifying = false; });
    return true;
  }

  if (msg.action === "twoWayInitialSync") {
    isSelfModifying = true;
    runInitialTwoWaySync(msg.mode, (phase, text) => {
      chrome.runtime.sendMessage({ action: "twoWayProgress", phase, text }).catch(() => {});
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
      .finally(() => { isSelfModifying = false; });
    return true;
  }

  if (msg.action === "twoWaySync") {
    isSelfModifying = true;
    runTwoWaySync((phase, text) => {
      chrome.runtime.sendMessage({ action: "twoWayProgress", phase, text }).catch(() => {});
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
      .finally(() => { isSelfModifying = false; });
    return true;
  }
});

// ===================== Two-Way Bookmark Listeners =====================

let twoWaySyncDebounceTimer = null;
let twoWaySyncRunning = false;
let isSelfModifying = false;

function debounceTwoWaySync() {
  if (twoWaySyncRunning || isSelfModifying) return;
  clearTimeout(twoWaySyncDebounceTimer);
  twoWaySyncDebounceTimer = setTimeout(async () => {
    twoWaySyncRunning = true;
    isSelfModifying = true;
    try {
      const settings = await getSettings();
      if (!settings.twoWayEnabled || !settings.twoWayInitialSyncDone) return;
      console.log("[Linkding] Bookmark change detected, running two-way sync...");
      const result = await runTwoWaySync((phase, msg) => console.log(`[Linkding] ${msg}`));
      console.log(`[Linkding] Two-way sync done: +${result.added} -${result.removed} ~${result.updated}`);
    } catch (err) {
      console.error("[Linkding] Two-way sync error:", err);
    } finally {
      isSelfModifying = false;
      twoWaySyncRunning = false;
    }
  }, 2000);
}

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
    debounceTwoWaySync();
  }
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  if (await isInsideTwoWaySyncFolder(removeInfo.parentId)) {
    debounceTwoWaySync();
  }
});

chrome.bookmarks.onChanged.addListener(async (id) => {
  try {
    const [node] = await chrome.bookmarks.get(id);
    if (await isInsideTwoWaySyncFolder(node.parentId)) {
      debounceTwoWaySync();
    }
  } catch {
    // bookmark gone
  }
});

chrome.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  const oldInside = await isInsideTwoWaySyncFolder(moveInfo.oldParentId);
  const newInside = await isInsideTwoWaySyncFolder(moveInfo.parentId);
  if (oldInside || newInside) {
    debounceTwoWaySync();
  }
});

// Initialize alarm on install/startup
chrome.runtime.onInstalled.addListener(() => updateAlarm());
chrome.runtime.onStartup.addListener(() => updateAlarm());
