const syncBtn = document.getElementById("sync");
const syncLabel = document.getElementById("sync-label");
const progressEl = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const resultEl = document.getElementById("result");

// --------------- Load last sync info on open ---------------

document.addEventListener("DOMContentLoaded", async () => {
  const s = await chrome.storage.sync.get({
    url: "",
    oneWayEnabled: true,
    autoSync: false,
    autoSyncInterval: 60,
    lastSyncTime: null,
    lastSyncCount: null,
    lastSyncTags: null,
    twoWayEnabled: false,
    twoWayInitialSyncDone: false,
    twoWayLastSyncTime: null,
    twoWaySyncTag: "bookmark-sync",
  });

  // Instance URL
  const urlEl = document.getElementById("instance-url");
  if (s.url) {
    try {
      urlEl.textContent = new URL(s.url).host;
    } catch {
      urlEl.textContent = s.url;
    }
  } else {
    urlEl.textContent = "Not configured";
  }

  // Auto-sync badge
  const badge = document.getElementById("auto-badge");
  const autoLabel = document.getElementById("auto-label");
  if (s.autoSync) {
    badge.className = "auto-badge on";
    autoLabel.textContent = `Auto-sync every ${formatInterval(s.autoSyncInterval)}`;
  } else {
    badge.className = "auto-badge off";
    autoLabel.textContent = "Auto-sync off";
  }

  const hasTwoWay = s.twoWayEnabled && s.twoWayInitialSyncDone;

  // One-way section
  if (s.oneWayEnabled) {
    document.getElementById("oneway-section").style.display = "block";
    // Add label if both modes are active
    if (hasTwoWay) {
      document.getElementById("oneway-label").textContent = "Full Download";
    }
  } else {
    document.getElementById("oneway-section").style.display = "none";
  }

  // Stats — show if one-way is enabled
  const statsEl = document.querySelector(".stats");
  if (s.oneWayEnabled) {
    statsEl.style.display = "flex";
    document.getElementById("stat-bookmarks").textContent =
      s.lastSyncCount != null ? s.lastSyncCount : "--";
    document.getElementById("stat-tags").textContent =
      s.lastSyncTags != null ? s.lastSyncTags : "--";
    document.getElementById("stat-last").textContent =
      s.lastSyncTime ? timeAgo(s.lastSyncTime) : "--";
    document.getElementById("last-sync-time").textContent =
      s.lastSyncTime ? `Last: ${new Date(s.lastSyncTime).toLocaleString()}` : "";
  } else {
    statsEl.style.display = "none";
    document.getElementById("last-sync-time").textContent = "";
  }

  // Two-way sync section
  if (hasTwoWay) {
    document.getElementById("twoway-section").style.display = "block";
    document.getElementById("twoway-last-sync").textContent =
      s.twoWayLastSyncTime
        ? `Tag: ${s.twoWaySyncTag} \u2022 Last: ${timeAgo(s.twoWayLastSyncTime)}`
        : `Tag: ${s.twoWaySyncTag}`;
  }
});

// --------------- Settings link ---------------

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// --------------- Sync via background worker ---------------

syncBtn.addEventListener("click", () => {
  syncBtn.disabled = true;
  syncBtn.classList.add("syncing");
  syncLabel.textContent = "Downloading...";
  resultEl.className = "result";
  progressEl.classList.add("visible");
  progressBar.className = "progress-bar-fill indeterminate";
  progressText.textContent = "Starting...";

  chrome.runtime.sendMessage({ action: "sync" }, (response) => {
    syncBtn.disabled = false;
    syncBtn.classList.remove("syncing");
    syncLabel.textContent = "Download Now";
    progressEl.classList.remove("visible");

    if (chrome.runtime.lastError) {
      showResult("error", "Could not reach background worker. Try reloading the extension.");
      return;
    }

    if (response && response.ok) {
      const r = response.result;
      showResult("success", `Synced ${r.bookmarks} bookmarks across ${r.tags} tag folders.`);
      // Update stats live
      document.getElementById("stat-bookmarks").textContent = r.bookmarks;
      document.getElementById("stat-tags").textContent = r.tags;
      document.getElementById("stat-last").textContent = "now";
      document.getElementById("last-sync-time").textContent =
        `Last: ${new Date().toLocaleString()}`;
    } else {
      showResult("error", response ? response.error : "Unknown error");
    }
  });
});

// --------------- Two-Way Sync ---------------

const twoWaySyncBtn = document.getElementById("twoway-sync");
const twoWaySyncLabel = document.getElementById("twoway-sync-label");
const twoWayResult = document.getElementById("twoway-result");

twoWaySyncBtn.addEventListener("click", () => {
  twoWaySyncBtn.disabled = true;
  twoWaySyncBtn.classList.add("syncing");
  twoWaySyncLabel.textContent = "Syncing...";
  twoWayResult.style.display = "none";

  chrome.runtime.sendMessage({ action: "twoWaySync" }, (response) => {
    twoWaySyncBtn.disabled = false;
    twoWaySyncBtn.classList.remove("syncing");
    twoWaySyncLabel.textContent = "Two-Way Sync";

    if (chrome.runtime.lastError) {
      showTwoWayResult("error", "Could not reach background worker.");
      return;
    }

    if (response && response.ok) {
      const r = response.result;
      const parts = [];
      if (r.added > 0) parts.push(`+${r.added} added`);
      if (r.removed > 0) parts.push(`-${r.removed} removed`);
      if (r.updated > 0) parts.push(`~${r.updated} updated`);
      const summary = parts.length > 0 ? parts.join(", ") : "Everything in sync";
      showTwoWayResult("success", `${summary} (${r.total} total)`);
      document.getElementById("twoway-last-sync").textContent =
        `Last: just now`;
    } else {
      showTwoWayResult("error", response ? response.error : "Unknown error");
    }
  });
});

function showTwoWayResult(type, text) {
  twoWayResult.style.display = "block";
  twoWayResult.className = `result visible ${type}`;
  twoWayResult.textContent = text;
}

// Listen for progress from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "syncProgress") {
    progressText.textContent = msg.text;
  }
});

// --------------- Helpers ---------------

function showResult(type, text) {
  resultEl.className = `result visible ${type}`;
  resultEl.textContent = text;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatInterval(mins) {
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  return h === 1 ? "1 hour" : `${h} hours`;
}
