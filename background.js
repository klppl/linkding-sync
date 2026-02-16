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
  try {
    const result = await runSync((phase, msg) => console.log(`[Linkding] ${msg}`));
    console.log(`[Linkding] Auto-sync done: ${result.bookmarks} bookmarks, ${result.tags} tags`);
  } catch (err) {
    console.error("[Linkding] Auto-sync error:", err);
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
  if (msg.action !== "sync") return;
  // Return true to keep sendResponse channel open for async
  runSync((phase, text) => {
    // Send progress back to popup
    chrome.runtime.sendMessage({ action: "syncProgress", phase, text }).catch(() => {});
  })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

// Initialize alarm on install/startup
chrome.runtime.onInstalled.addListener(() => updateAlarm());
chrome.runtime.onStartup.addListener(() => updateAlarm());
