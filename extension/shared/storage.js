// Storage wrappers for chrome.storage.local
// profileSchema.js must be loaded before this file.

const StorageKeys = {
  PROFILE: "profile",
  APP_LOG: "appLog",
  ANSWERS: "answers",
};

async function getProfile() {
  const result = await chrome.storage.local.get(StorageKeys.PROFILE);
  return { ...PROFILE_DEFAULTS, ...(result[StorageKeys.PROFILE] || {}) };
}

async function saveProfile(partial) {
  const existing = await getProfile();
  await chrome.storage.local.set({
    [StorageKeys.PROFILE]: { ...existing, ...partial },
  });
}

async function getAppLog() {
  const result = await chrome.storage.local.get(StorageKeys.APP_LOG);
  return result[StorageKeys.APP_LOG] || [];
}

// Returns the answers DB entries array (seeded from credentials/answers.json on startup)
async function getAnswers() {
  const result = await chrome.storage.local.get(StorageKeys.ANSWERS);
  return result[StorageKeys.ANSWERS] || [];
}

// Save a question+answer pair to the local DB so it's reused next time.
// If an entry matching this question already exists, the answer is updated.
async function saveAnswer(question, answer) {
  const entries = await getAnswers();
  const pattern = (question || "").toLowerCase().trim();
  if (!pattern || !answer) return;

  const idx = entries.findIndex(e =>
    (e.patterns || []).some(p => p.toLowerCase() === pattern)
  );

  if (idx >= 0) {
    entries[idx].answer = answer;
  } else {
    entries.push({ patterns: [pattern], answer });
  }

  await chrome.storage.local.set({ [StorageKeys.ANSWERS]: entries });
}

async function appendAppLog(entry) {
  const log = await getAppLog();
  log.unshift({ ...entry, timestamp: Date.now() });
  // Keep last 500 entries
  if (log.length > 500) log.length = 500;
  await chrome.storage.local.set({ [StorageKeys.APP_LOG]: log });
}

async function getSeenJobs() {
  const result = await chrome.storage.local.get('seenJobUrls');
  return new Set(Array.isArray(result.seenJobUrls) ? result.seenJobUrls : []);
}

async function addSeenJob(url) {
  if (!url) return;
  const seen = await getSeenJobs();
  seen.add(url);
  await chrome.storage.local.set({ seenJobUrls: [...seen] });
}
