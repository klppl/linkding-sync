let selectedParentId = null;
let selectedInterval = 60;
let selectedTwoWayFolderId = null;

// ===================== Bookmark tree =====================

async function loadTree() {
  const tree = await chrome.bookmarks.getTree();
  const container = document.getElementById("folder-tree");
  container.innerHTML = "";
  const ul = document.createElement("ul");
  for (const child of tree[0].children || []) {
    renderNode(child, ul, "oneway");
  }
  container.appendChild(ul);

  // Restore saved selection
  const { parentFolderId } = await chrome.storage.sync.get({ parentFolderId: null });
  if (parentFolderId) selectFolder(parentFolderId, "oneway");
}

async function loadTwoWayTree() {
  const tree = await chrome.bookmarks.getTree();
  const container = document.getElementById("twoway-folder-tree");
  container.innerHTML = "";
  const ul = document.createElement("ul");
  for (const child of tree[0].children || []) {
    renderNode(child, ul, "twoway");
  }
  container.appendChild(ul);

  // Restore saved selection
  const { twoWaySyncFolderId } = await chrome.storage.sync.get({ twoWaySyncFolderId: null });
  if (twoWaySyncFolderId) selectFolder(twoWaySyncFolderId, "twoway");
}

function renderNode(node, parentUl, treeType) {
  if (node.url) return;

  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.id = node.id;
  row.dataset.treeType = treeType;

  const toggle = document.createElement("span");
  toggle.className = "tree-toggle";
  const childFolders = (node.children || []).filter((c) => !c.url);
  toggle.textContent = childFolders.length ? "\u25B6" : "";

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.title || "(root)";

  row.appendChild(toggle);
  row.appendChild(label);
  li.appendChild(row);

  let childUl = null;
  if (childFolders.length) {
    childUl = document.createElement("ul");
    childUl.style.display = "none";
    for (const child of childFolders) {
      renderNode(child, childUl, treeType);
    }
    li.appendChild(childUl);
  }

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!childUl) return;
    const open = childUl.style.display !== "none";
    childUl.style.display = open ? "none" : "block";
    toggle.textContent = open ? "\u25B6" : "\u25BC";
  });

  row.addEventListener("click", () => selectFolder(node.id, treeType));
  parentUl.appendChild(li);
}

function selectFolder(id, treeType) {
  const containerId = treeType === "twoway" ? "twoway-folder-tree" : "folder-tree";
  const container = document.getElementById(containerId);

  const prev = container.querySelector(".tree-row.selected");
  if (prev) prev.classList.remove("selected");

  const row = container.querySelector(`.tree-row[data-id="${id}"]`);
  if (row) {
    row.classList.add("selected");
    let parent = row.closest("ul");
    while (parent && parent.closest(".tree-container") && parent !== container) {
      parent.style.display = "block";
      const prevSib = parent.previousElementSibling;
      if (prevSib) {
        const t = prevSib.querySelector(".tree-toggle");
        if (t) t.textContent = "\u25BC";
      }
      parent = parent.parentElement?.closest("ul");
    }
  }

  if (treeType === "twoway") {
    selectedTwoWayFolderId = id;
    updateTwoWayPathDisplay(id);
    checkFolderConflict();
  } else {
    selectedParentId = id;
    updatePathDisplay(id);
  }
}

async function updatePathDisplay(id) {
  const parts = [];
  let currentId = id;
  while (currentId) {
    const [node] = await chrome.bookmarks.get(currentId);
    parts.unshift(node.title || "(root)");
    currentId = node.parentId;
  }
  const folderName = document.getElementById("folder-name").value.trim() || "Linkding";
  const pathEl = document.getElementById("selected-path");
  pathEl.textContent = parts.join(" / ") + " / " + folderName;
  pathEl.classList.add("visible");
}

async function updateTwoWayPathDisplay(id) {
  const parts = [];
  let currentId = id;
  while (currentId) {
    const [node] = await chrome.bookmarks.get(currentId);
    parts.unshift(node.title || "(root)");
    currentId = node.parentId;
  }
  const pathEl = document.getElementById("twoway-selected-path");
  pathEl.textContent = parts.join(" / ");
  pathEl.classList.add("visible");
}

// ===================== Folder conflict validation =====================

async function getOneWayFolderId() {
  if (!selectedParentId) return null;
  const folderName = document.getElementById("folder-name").value.trim() || "Linkding";
  try {
    const children = await chrome.bookmarks.getChildren(selectedParentId);
    const existing = children.find((n) => !n.url && n.title === folderName);
    return existing ? existing.id : null;
  } catch {
    return null;
  }
}

async function isDescendantOf(childId, ancestorId) {
  let currentId = childId;
  while (currentId) {
    if (currentId === ancestorId) return true;
    try {
      const [node] = await chrome.bookmarks.get(currentId);
      currentId = node.parentId;
    } catch {
      return false;
    }
  }
  return false;
}

async function checkFolderConflict() {
  const warning = document.getElementById("folder-conflict-warning");
  if (!selectedTwoWayFolderId || !selectedParentId || !oneWayToggle.checked) {
    warning.classList.remove("visible");
    return false;
  }

  const oneWayFolderId = await getOneWayFolderId();

  if (oneWayFolderId && selectedTwoWayFolderId === oneWayFolderId) {
    warning.classList.add("visible");
    return true;
  }

  if (oneWayFolderId && await isDescendantOf(selectedTwoWayFolderId, oneWayFolderId)) {
    warning.classList.add("visible");
    return true;
  }

  warning.classList.remove("visible");
  return false;
}

// ===================== Auto-sync UI =====================

const autoSyncToggle = document.getElementById("auto-sync");
const intervalRow = document.getElementById("interval-row");
const intervalOptions = document.querySelectorAll(".interval-opt");

autoSyncToggle.addEventListener("change", () => {
  intervalRow.classList.toggle("visible", autoSyncToggle.checked);
});

intervalOptions.forEach((opt) => {
  opt.addEventListener("click", () => {
    intervalOptions.forEach((o) => o.classList.remove("active"));
    opt.classList.add("active");
    selectedInterval = parseInt(opt.dataset.val);
  });
});

// ===================== One-Way Sync UI =====================

const oneWayToggle = document.getElementById("oneway-enabled");
const oneWaySettings = document.getElementById("oneway-settings");

oneWayToggle.addEventListener("change", () => {
  oneWaySettings.classList.toggle("visible", oneWayToggle.checked);
  if (oneWayToggle.checked) {
    loadTree();
  }
  checkFolderConflict();
});

// ===================== Two-Way Sync UI =====================

const twoWayToggle = document.getElementById("twoway-enabled");
const twoWaySettings = document.getElementById("twoway-settings");

twoWayToggle.addEventListener("change", () => {
  twoWaySettings.classList.toggle("visible", twoWayToggle.checked);
  if (twoWayToggle.checked) {
    loadTwoWayTree();
  }
});

// Radio option selection
document.querySelectorAll("#initial-mode-group .radio-option").forEach((opt) => {
  opt.addEventListener("click", () => {
    document.querySelectorAll("#initial-mode-group .radio-option").forEach((o) => o.classList.remove("selected"));
    opt.classList.add("selected");
    opt.querySelector("input[type=radio]").checked = true;
  });
});

// Initial sync button
document.getElementById("start-initial-sync").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="initial-mode"]:checked').value;
  const btn = document.getElementById("start-initial-sync");
  const progress = document.getElementById("initial-progress");
  const progressText = document.getElementById("initial-progress-text");

  btn.disabled = true;
  btn.textContent = "Syncing...";
  progress.classList.add("visible");
  progressText.textContent = "Starting initial sync...";

  chrome.runtime.sendMessage({ action: "twoWayInitialSync", mode }, (response) => {
    btn.disabled = false;
    btn.textContent = "Start Initial Sync";
    progress.classList.remove("visible");

    if (chrome.runtime.lastError) {
      showToast("error", "Could not reach background worker. Try reloading the extension.");
      return;
    }

    if (response && response.ok) {
      const r = response.result;
      showToast("success", `Initial sync complete!\nAdded: ${r.added}, Updated: ${r.updated}, Downloaded: ${r.downloaded}, Total: ${r.total}`);
      document.getElementById("initial-sync-section").classList.remove("visible");
      document.getElementById("initial-done-badge").classList.add("visible");
    } else {
      showToast("error", response ? response.error : "Unknown error");
    }
  });
});

// Listen for two-way progress
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "twoWayProgress") {
    const progressText = document.getElementById("initial-progress-text");
    if (progressText) progressText.textContent = msg.text;
  }
});

// ===================== Load settings =====================

document.addEventListener("DOMContentLoaded", async () => {
  const s = await chrome.storage.sync.get({
    url: "",
    token: "",
    folderName: "Linkding",
    parentFolderId: null,
    oneWayEnabled: true,
    excludedTags: "bookmark-sync",
    autoSync: false,
    autoSyncInterval: 60,
    twoWayEnabled: false,
    twoWaySyncTag: "bookmark-sync",
    twoWaySyncFolderId: null,
    twoWayInitialSyncDone: false,
  });

  document.getElementById("url").value = s.url;
  document.getElementById("token").value = s.token;
  document.getElementById("folder-name").value = s.folderName;
  document.getElementById("excluded-tags").value = s.excludedTags;

  // One-way sync
  oneWayToggle.checked = s.oneWayEnabled;
  if (s.oneWayEnabled) {
    oneWaySettings.classList.add("visible");
  }

  // Auto-sync
  autoSyncToggle.checked = s.autoSync;
  if (s.autoSync) intervalRow.classList.add("visible");
  selectedInterval = s.autoSyncInterval;
  intervalOptions.forEach((opt) => {
    if (parseInt(opt.dataset.val) === s.autoSyncInterval) opt.classList.add("active");
  });

  // Two-way sync
  twoWayToggle.checked = s.twoWayEnabled;
  if (s.twoWayEnabled) {
    twoWaySettings.classList.add("visible");
    await loadTwoWayTree();
  }
  document.getElementById("twoway-tag").value = s.twoWaySyncTag;
  selectedTwoWayFolderId = s.twoWaySyncFolderId;

  if (s.twoWayEnabled && s.twoWayInitialSyncDone) {
    document.getElementById("initial-done-badge").classList.add("visible");
  } else if (s.twoWayEnabled) {
    document.getElementById("initial-sync-section").classList.add("visible");
  }

  // Load one-way tree (always, so selection is restored)
  await loadTree();
});

document.getElementById("folder-name").addEventListener("input", () => {
  if (selectedParentId) updatePathDisplay(selectedParentId);
  checkFolderConflict();
});

// ===================== Test connection =====================

document.getElementById("test").addEventListener("click", async () => {
  const url = document.getElementById("url").value.trim().replace(/\/+$/, "");
  const token = document.getElementById("token").value.trim();

  if (!url || !token) {
    showToast("error", "Enter a URL and API token first.");
    return;
  }

  setConnectionStatus("testing", "Testing...");

  try {
    const resp = await fetch(`${url}/api/bookmarks/?limit=1`, {
      headers: { Authorization: `Token ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      setConnectionStatus("ok", `Connected \u2014 ${data.count} bookmarks`);
    } else {
      setConnectionStatus("fail", `Error ${resp.status}: ${resp.statusText}`);
    }
  } catch (err) {
    setConnectionStatus("fail", `Failed: ${err.message}`);
  }
});

function setConnectionStatus(state, text) {
  const el = document.getElementById("conn-status");
  el.className = `connection-status ${state}`;
  document.getElementById("conn-text").textContent = text;
}

// ===================== Save =====================

document.getElementById("save").addEventListener("click", async () => {
  const url = document.getElementById("url").value.trim().replace(/\/+$/, "");
  const token = document.getElementById("token").value.trim();
  const folderName = document.getElementById("folder-name").value.trim() || "Linkding";
  const oneWayEnabled = oneWayToggle.checked;
  const autoSync = autoSyncToggle.checked;
  const twoWayEnabled = twoWayToggle.checked;
  const twoWaySyncTag = document.getElementById("twoway-tag").value.trim() || "bookmark-sync";

  if (!url || !token) {
    showToast("error", "URL and API token are required.");
    return;
  }

  if (!oneWayEnabled && !twoWayEnabled) {
    showToast("error", "Enable at least one sync mode.");
    return;
  }

  if (oneWayEnabled && !selectedParentId) {
    showToast("error", "Select a parent folder for the full download.");
    return;
  }

  if (twoWayEnabled) {
    if (!selectedTwoWayFolderId) {
      showToast("error", "Select a folder for two-way sync.");
      return;
    }
    if (!twoWaySyncTag) {
      showToast("error", "Enter a sync tag for two-way sync.");
      return;
    }
    if (oneWayEnabled) {
      const hasConflict = await checkFolderConflict();
      if (hasConflict) {
        showToast("error", "Two-way sync folder conflicts with the full download folder. Choose a different folder.");
        return;
      }
    }

    const { twoWayInitialSyncDone } = await chrome.storage.sync.get({ twoWayInitialSyncDone: false });
    if (!twoWayInitialSyncDone) {
      document.getElementById("initial-sync-section").classList.add("visible");
    }
  }

  chrome.storage.sync.set(
    {
      url,
      token,
      folderName,
      parentFolderId: oneWayEnabled ? selectedParentId : null,
      oneWayEnabled,
      excludedTags: document.getElementById("excluded-tags").value.trim(),
      autoSync,
      autoSyncInterval: selectedInterval,
      twoWayEnabled,
      twoWaySyncTag,
      twoWaySyncFolderId: twoWayEnabled ? selectedTwoWayFolderId : null,
    },
    () => showToast("success", "Settings saved!")
  );
});

// ===================== Toast =====================

let toastTimer;
function showToast(type, msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  void el.offsetWidth;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 3000);
}
// ===================== Manual Sync =====================

function runManualSync(mode) {
  const btnId = `force-${mode}-btn`;
  const btn = document.getElementById(btnId);
  const progress = document.getElementById("manual-progress");
  const progressText = document.getElementById("manual-progress-text");

  // Confirm destructive actions
  if (mode === "push") {
    if (!confirm("FORCE PUSH: This will OVERWRITE Linkding bookmarks with your Chrome bookmarks for the synced tag. Linkding tags on these bookmarks might be reset to just the sync tags. Continue?")) return;
  }
  if (mode === "pull") {
    if (!confirm("FORCE PULL: This will REPLACE your Chrome bookmarks in the sync folder with data from Linkding. Any Chrome-only bookmarks in this folder will be lost. Continue?")) return;
  }

  // Disable all buttons
  ["push", "pull", "merge"].forEach(m => {
    document.getElementById(`force-${m}-btn`).disabled = true;
  });

  btn.textContent = "Syncing...";
  progress.classList.add("visible");
  progressText.textContent = `Starting force ${mode}...`;

  // Reset bar
  const fill = document.getElementById("manual-progress-fill");
  if (fill) {
    fill.style.width = "0%";
    fill.style.animation = "indeterminate 1.5s infinite linear"; // Start with indeterminate until numbers arrive
  }

  chrome.runtime.sendMessage({ action: "twoWayInitialSync", mode }, (response) => {
    // Re-enable buttons
    ["push", "pull", "merge"].forEach(m => {
      document.getElementById(`force-${m}-btn`).disabled = false;
    });
    document.getElementById("force-push-btn").textContent = "Force Push";
    document.getElementById("force-pull-btn").textContent = "Force Pull";
    document.getElementById("force-merge-btn").textContent = "Force Merge";

    progress.classList.remove("visible");

    if (chrome.runtime.lastError) {
      showToast("error", "Could not reach background worker. Try reloading.");
      return;
    }

    if (response && response.ok) {
      const r = response.result;
      let msg = `${mode} complete!\nAdded: ${r.added}, Updated: ${r.updated}, Downloaded: ${r.downloaded}`;
      if (r.configError) {
        msg += `\n\nWARNING: Config bookmark failed: ${r.configError}`;
        showToast("error", msg); // Show as error if config failed
      } else {
        showToast("success", msg);
      }
    } else {
      showToast("error", response ? response.error : "Unknown error");
    }
  });
}

document.getElementById("force-push-btn").addEventListener("click", () => runManualSync("push"));
document.getElementById("force-pull-btn").addEventListener("click", () => runManualSync("pull"));
document.getElementById("force-merge-btn").addEventListener("click", () => runManualSync("merge"));
// Listen for progress updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "twoWayProgress") {
    const text = msg.text || "";
    const progressFill = document.getElementById("manual-progress-fill");
    const progressText = document.getElementById("manual-progress-text");

    if (progressFill && progressText) {
      progressText.textContent = text;

      // parsing "Pushed X of Y..."
      const match = text.match(/(?:Pushed|Pulled|Merged)\s+(\d+)\s+of\s+(\d+)/);
      if (match) {
        const current = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        if (total > 0) {
          const pct = Math.round((current / total) * 100);
          progressFill.style.width = `${pct}%`;
        }
      } else if (text.startsWith("Fetching") || text.startsWith("Reading")) {
        progressFill.style.width = "5%"; // Indeterminate / starting
        progressFill.style.animation = "indeterminate 1.5s infinite linear";
        // Re-enable indeterminate animation if needed, or just set a small width
      } else {
        progressFill.style.animation = "none";
      }
    }
  }
});
