const STATUS_LABELS = {
  idle: "Idle",
  running: "Running…",
  paused: "Paused",
  waiting_user: "Waiting for you",
  done: "Done!",
  error: "Error",
};

async function init() {
  const profile = await getProfile();

  // API key warning
  if (!profile.claudeApiKey) {
    document.getElementById("api-key-warning").classList.remove("hidden");
  }

  // Load recent log
  const log = await getAppLog();
  renderLog(log);

  // Query current fill status from the active content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const response = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATUS }).catch(() => null);
      if (response) updateStatus(response.status || "idle");
    }
  } catch {
    // Content script not present on this page — that's fine
  }
}

function updateStatus(status) {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  dot.className = `dot ${status}`;
  text.textContent = STATUS_LABELS[status] || "Unknown";
}

function renderLog(entries) {
  const list = document.getElementById("log-list");
  if (!entries || entries.length === 0) {
    list.innerHTML = '<li class="empty">No applications yet.</li>';
    return;
  }
  list.innerHTML = entries
    .slice(0, 8)
    .map((e) => {
      const date = new Date(e.timestamp).toLocaleDateString();
      return `<li><strong>${escapeHtml(e.role || "Unknown role")}</strong> — ${escapeHtml(e.company || "")} <span class="date">${date}</span></li>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Listen for status updates forwarded from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.FILL_STATUS && msg.payload) {
    updateStatus(msg.payload.status);
  }
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

init();
