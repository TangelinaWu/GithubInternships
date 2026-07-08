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

// Jobs whose page couldn't be auto-detected/auto-applied and were skipped
// from the failed state — kept here (instead of being logged straight to
// Sheets as Skipped) so the user can revisit and manually apply later.
async function getNeedsAttention() {
  const result = await chrome.storage.local.get('needsAttention');
  return Array.isArray(result.needsAttention) ? result.needsAttention : [];
}

async function addNeedsAttention(entry) {
  const list = await getNeedsAttention();
  const deduped = list.filter(e => e.url !== entry.url);
  deduped.unshift({ ...entry, addedAt: Date.now() });
  await chrome.storage.local.set({ needsAttention: deduped });
  return deduped;
}

async function removeNeedsAttention(url) {
  const list = await getNeedsAttention();
  const next = list.filter(e => e.url !== url);
  await chrome.storage.local.set({ needsAttention: next });
  return next;
}

// Tracks repeat "open the Apply link as a new window" attempts for the same
// source→target pair. A slow ATS page load that the user stops (or that
// times out and reloads) re-runs extraction from scratch, which can find the
// same cross-page Apply link and spawn another window every time — this caps
// it at two windows for the same pair before giving up.
const APPLY_CLICK_RETRY_KEY = 'applyClickRetry';
const APPLY_CLICK_RETRY_LIMIT = 2;

async function shouldOpenApplyWindow(sourceUrl, targetUrl) {
  const result = await chrome.storage.local.get(APPLY_CLICK_RETRY_KEY);
  const state = result[APPLY_CLICK_RETRY_KEY];
  const isSameAttempt = state && state.sourceUrl === sourceUrl && state.targetUrl === targetUrl;
  const count = isSameAttempt ? state.count : 0;
  if (count >= APPLY_CLICK_RETRY_LIMIT) return false;
  await chrome.storage.local.set({
    [APPLY_CLICK_RETRY_KEY]: { sourceUrl, targetUrl, count: count + 1 },
  });
  return true;
}
