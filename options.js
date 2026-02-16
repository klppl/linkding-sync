let selectedParentId = null;
let selectedInterval = 60;

// ===================== Bookmark tree =====================

async function loadTree() {
  const tree = await chrome.bookmarks.getTree();
  const container = document.getElementById("folder-tree");
  container.innerHTML = "";
  const ul = document.createElement("ul");
  for (const child of tree[0].children || []) {
    renderNode(child, ul);
  }
  container.appendChild(ul);

  // Restore saved selection
  const { parentFolderId } = await chrome.storage.sync.get({ parentFolderId: null });
  if (parentFolderId) selectFolder(parentFolderId);
}

function renderNode(node, parentUl) {
  if (node.url) return;

  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.id = node.id;

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
      renderNode(child, childUl);
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

  row.addEventListener("click", () => selectFolder(node.id));
  parentUl.appendChild(li);
}

function selectFolder(id) {
  const prev = document.querySelector(".tree-row.selected");
  if (prev) prev.classList.remove("selected");

  const row = document.querySelector(`.tree-row[data-id="${id}"]`);
  if (row) {
    row.classList.add("selected");
    let parent = row.closest("ul");
    while (parent && parent.closest(".tree-container") && parent !== document.getElementById("folder-tree")) {
      parent.style.display = "block";
      const prevSib = parent.previousElementSibling;
      if (prevSib) {
        const t = prevSib.querySelector(".tree-toggle");
        if (t) t.textContent = "\u25BC";
      }
      parent = parent.parentElement?.closest("ul");
    }
  }

  selectedParentId = id;
  updatePathDisplay(id);
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

// ===================== Load settings =====================

document.addEventListener("DOMContentLoaded", async () => {
  const s = await chrome.storage.sync.get({
    url: "",
    token: "",
    folderName: "Linkding",
    parentFolderId: null,
    autoSync: false,
    autoSyncInterval: 60,
  });

  document.getElementById("url").value = s.url;
  document.getElementById("token").value = s.token;
  document.getElementById("folder-name").value = s.folderName;

  // Auto-sync
  autoSyncToggle.checked = s.autoSync;
  if (s.autoSync) intervalRow.classList.add("visible");
  selectedInterval = s.autoSyncInterval;
  intervalOptions.forEach((opt) => {
    if (parseInt(opt.dataset.val) === s.autoSyncInterval) opt.classList.add("active");
  });

  await loadTree();
});

document.getElementById("folder-name").addEventListener("input", () => {
  if (selectedParentId) updatePathDisplay(selectedParentId);
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

document.getElementById("save").addEventListener("click", () => {
  const url = document.getElementById("url").value.trim().replace(/\/+$/, "");
  const token = document.getElementById("token").value.trim();
  const folderName = document.getElementById("folder-name").value.trim() || "Linkding";
  const autoSync = autoSyncToggle.checked;

  if (!url || !token) {
    showToast("error", "URL and API token are required.");
    return;
  }
  if (!selectedParentId) {
    showToast("error", "Select a parent folder from the tree.");
    return;
  }

  chrome.storage.sync.set(
    {
      url,
      token,
      folderName,
      parentFolderId: selectedParentId,
      autoSync,
      autoSyncInterval: selectedInterval,
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
  // Force reflow before adding visible
  void el.offsetWidth;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 3000);
}
