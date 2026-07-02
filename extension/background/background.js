// Background page — GH Internships extension
// Handles: fit checks via Claude API, sheets logging, overlay Q&A, seen-URL sync

const SHEETS_PORT = 3743

// Must stay longer than CLAUDE_FIT_TIMEOUT_MS (defined below) — see its use
// in the batch queue's safety-advance timer.
const QUEUE_SAFETY_TIMEOUT_MS = 210000

// Seed LinkedIn email on first run (reused from shared profile)
;(async () => {
  const profile = await getProfile()
  if (!profile.linkedinEmail) {
    await saveProfile({ linkedinEmail: 'tangelinawu100@gmail.com' })
  }
})()

// Sync seen job URLs from Sheets on startup
;(async () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500))
      const resp = await fetch(`http://127.0.0.1:${SHEETS_PORT}/seen`)
      if (!resp.ok) return
      const { urls } = await resp.json()
      if (!Array.isArray(urls)) return
      const seen = await getSeenJobs()
      for (const u of urls) seen.add(u)
      await chrome.storage.local.set({ seenJobUrls: [...seen] })
      console.log(`[GHInternships] Synced ${urls.length} seen URLs from Sheets`)
      return
    } catch {
      // Server not ready — retry
    }
  }
  console.warn('[GHInternships] Sheets server unavailable on startup')
})()

// Track overlay questions: requestId → { tabId, question }
const pendingQuestions = new Map()

// Track open GitHub repo tabs and their pending-new counts, for the control
// panel's "which page do you want to apply to" picker.
const _sources = new Map()  // tabId → { tabId, repo, pending }

function broadcastSources() {
  chrome.runtime.sendMessage({
    type:    MSG.SOURCES_UPDATED,
    payload: { sources: [..._sources.values()] },
  }).catch(() => {})
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (_sources.delete(tabId)) broadcastSources()
})

// On startup: clear stale queue state so _queueRunning starts clean
chrome.storage.local.remove(['autoApplyQueue', 'autoApplyGithubTabId', 'autoApplyTotal', 'autoApplyDone'])

// ── Batch auto-apply queue ────────────────────────────────────────────────────
//
// Each job opens as its own new tab via the GitHub tab's own window.open /
// anchor-click (MSG.OPEN_JOB_URL) — never chrome.tabs.create/update, which
// doesn't reliably produce a visible window in the Electron shell.

let _queueTimer   = null
let _queueRunning = false

// Advance the batch queue, but only if one is actually running — used at
// every point where a job's automatic processing has concluded (extraction
// failed, filled-awaiting-confirmation, or fill failed) so the queue keeps
// moving without waiting on the user's manual Applied/Skip confirmation.
function advanceQueueIfRunning() {
  chrome.storage.local.get('autoApplyQueue', ({ autoApplyQueue }) => {
    if (autoApplyQueue !== undefined) advanceQueue()
  })
}

function advanceQueue() {
  if (_queueTimer) { clearTimeout(_queueTimer); _queueTimer = null }

  chrome.storage.local.get(
    ['autoApplyQueue', 'autoApplyGithubTabId', 'autoApplyTotal', 'autoApplyDone'],
    (data) => {
      const queue  = data.autoApplyQueue
      const total  = data.autoApplyTotal  || 0
      const done   = (data.autoApplyDone  || 0) + 1
      const ghTab  = data.autoApplyGithubTabId

      if (!Array.isArray(queue) || queue.length === 0) {
        // All jobs processed
        _queueRunning = false
        const donePayload = { done, total }
        if (ghTab) chrome.tabs.sendMessage(ghTab, { type: MSG.QUEUE_DONE, payload: donePayload }).catch(() => {})
        chrome.runtime.sendMessage({ type: MSG.QUEUE_DONE, payload: donePayload }).catch(() => {})
        chrome.storage.local.remove(['autoApplyQueue', 'autoApplyGithubTabId', 'autoApplyTotal', 'autoApplyDone'])
        return
      }

      const [nextUrl, ...remaining] = queue
      chrome.storage.local.set({ autoApplyQueue: remaining, autoApplyDone: done })

      const progPayload = { done, total }
      if (ghTab) {
        chrome.tabs.sendMessage(ghTab, { type: MSG.QUEUE_PROGRESS, payload: progPayload }).catch(() => {})
        chrome.tabs.sendMessage(ghTab, { type: MSG.OPEN_JOB_URL, payload: { url: nextUrl } }).catch(() => {})
      }
      chrome.runtime.sendMessage({ type: MSG.QUEUE_PROGRESS, payload: progPayload }).catch(() => {})

      // Safety: advance if the page never logs. Must stay longer than the
      // Claude fit-check timeout (below) — otherwise the queue can race
      // ahead to the next job while this one's fit-check is still in flight,
      // and both would stomp on the same shared claudeJobResult storage key.
      _queueTimer = setTimeout(advanceQueue, QUEUE_SAFETY_TIMEOUT_MS)
    }
  )
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Batch queue: start processing a list of apply URLs ─────────────────
  if (message.type === MSG.QUEUE_START) {
    const { urls, total } = message.payload || {}
    if (!Array.isArray(urls) || urls.length === 0) return false

    // Only one queue at a time — multiple GitHub tabs may fire this simultaneously
    if (_queueRunning) return false
    _queueRunning = true

    const [firstUrl, ...remaining] = urls
    const ghTabId = sender.tab?.id

    chrome.storage.local.set({
      autoApplyQueue:       remaining,
      autoApplyGithubTabId: ghTabId,
      autoApplyTotal:       total || urls.length,
      autoApplyDone:        0,
    })

    // Don't re-broadcast QUEUE_START — control panel already receives it
    // directly from github.js via chrome.runtime.sendMessage

    if (ghTabId) {
      chrome.tabs.sendMessage(ghTabId, { type: MSG.OPEN_JOB_URL, payload: { url: firstUrl } }).catch(() => {})
    }
    if (_queueTimer) clearTimeout(_queueTimer)
    _queueTimer = setTimeout(advanceQueue, QUEUE_SAFETY_TIMEOUT_MS)
    return false
  }

  // ── Fit check (Claude API) ──────────────────────────────────────────────
  if (message.type === MSG.CHECK_FIT) {
    handleFitCheck(message.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }))
    return true
  }

  // ── Scan manually-filled-in answers → merge into answers.json ──────────
  if (message.type === MSG.SCAN_ANSWERS) {
    handleScanAnswers(message.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }))
    return true
  }

  // ── ATS assessor: new job detected (or extraction failed outright) ──────
  if (message.type === MSG.GH_ASSESSING || message.type === MSG.GH_ASSESS_FAILED) {
    // Track source tab so GH_DO_APPLY/GH_DO_SKIP can be routed back
    if (sender.tab?.id) {
      chrome.storage.local.set({ ghAssessingTabId: sender.tab.id })
    }
    // Forward to control panel
    chrome.runtime.sendMessage(message).catch(() => {})
    // Couldn't read this page — move on to the next queued job rather than
    // stalling until the safety timeout.
    if (message.type === MSG.GH_ASSESS_FAILED) advanceQueueIfRunning()
    return false
  }

  // ── Fit result: forward to control panel ───────────────────────────────
  if (message.type === MSG.FIT_RESULT) {
    chrome.runtime.sendMessage(message).catch(() => {})
    return false
  }

  // ── Control panel → ATS tab: Apply or Skip ─────────────────────────────
  if (message.type === MSG.GH_DO_APPLY || message.type === MSG.GH_DO_SKIP) {
    chrome.storage.local.get('ghAssessingTabId', ({ ghAssessingTabId }) => {
      if (ghAssessingTabId) {
        chrome.tabs.sendMessage(ghAssessingTabId, message).catch(() => {})
      }
    })
    return false
  }

  // ── Sheets logging ──────────────────────────────────────────────────────
  if (message.type === MSG.LOG_APPLICATION) {
    appendAppLog(message.payload).catch(() => {})
    fetch(`http://127.0.0.1:${SHEETS_PORT}/log`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message.payload),
    }).catch(() => {})
    if (message.payload?.url) {
      addSeenJob(message.payload.url).catch(() => {})
    }
    // Forward result to control panel activity log
    chrome.runtime.sendMessage({ type: MSG.LOG_APPLICATION, payload: message.payload }).catch(() => {})
    advanceQueueIfRunning()
    return false
  }

  // ── Sheets logging: application opened ──────────────────────────────────
  if (message.type === MSG.LOG_APPLICATION_OPENED) {
    fetch(`http://127.0.0.1:${SHEETS_PORT}/log-opened`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message.payload),
    }).catch(() => {})
    return false
  }

  // ── Overlay Q&A (form filler unknown fields) ────────────────────────────
  if (message.type === MSG.OVERLAY_QUESTION) {
    const tabId = sender.tab?.id
    const { requestId, question, fieldContext } = message.payload || {}
    if (!tabId || !requestId) return false
    pendingQuestions.set(requestId, { tabId, question })
    handleClaudeRequest({ question, fieldContext })
      .then(response => {
        const suggestion = response.error ? '' : (response.suggestion || '')
        chrome.runtime.sendMessage({
          type:    MSG.OVERLAY_QUESTION,
          payload: { requestId, question, suggestion },
        }).catch(() => {})
      })
    return false
  }

  if (message.type === MSG.OVERLAY_ANSWER) {
    const { requestId, accepted, value } = message.payload || {}
    const pending = pendingQuestions.get(requestId)
    if (pending !== undefined) {
      pendingQuestions.delete(requestId)
      chrome.tabs.sendMessage(pending.tabId, {
        type:    MSG.OVERLAY_ANSWER,
        payload: { requestId, accepted, value },
      }).catch(() => {})
      if (accepted && value) {
        saveAnswer(pending.question, value).catch(() => {})
      }
    }
    return false
  }

  // ── Focus tab ───────────────────────────────────────────────────────────
  if (message.type === MSG.FOCUS_TAB) {
    if (sender.tab?.id) chrome.tabs.update(sender.tab.id, { active: true })
    return false
  }

  // ── Auto-apply pipeline messages ────────────────────────────────────────
  if ([MSG.AUTO_APPLY_STARTED, MSG.AUTO_APPLY_FILLING, MSG.AUTO_APPLY_COMPLETE, MSG.AUTO_APPLY_FAILED].includes(message.type)) {
    chrome.runtime.sendMessage(message).catch(() => {})
    // Neither COMPLETE nor FAILED auto-logs a decision — the form being
    // filled (or not) isn't the same as the user confirming it was actually
    // submitted. Move the batch queue on regardless, so one job awaiting
    // confirmation (or one that needs manual attention) never stalls the rest.
    if (message.type === MSG.AUTO_APPLY_COMPLETE || message.type === MSG.AUTO_APPLY_FAILED) {
      advanceQueueIfRunning()
    }
    return false
  }

  // ── Diagnostic fill log ─────────────────────────────────────────────────
  if (message.type === MSG.FILL_LOG) {
    chrome.runtime.sendMessage(message).catch(() => {})
    return false
  }

  // ── Form field discovery ────────────────────────────────────────────────
  if (message.type === MSG.FORM_DISCOVERED) {
    const entry = Object.assign({}, message.payload, { scannedAt: new Date().toISOString() })
    chrome.storage.local.get('discoveredFields', ({ discoveredFields }) => {
      const existing = Array.isArray(discoveredFields) ? discoveredFields : []
      const deduped  = existing.filter(e => e.url !== entry.url)
      chrome.storage.local.set({ discoveredFields: [...deduped, entry] })
    })
    chrome.runtime.sendMessage(message).catch(() => {})
    return false
  }

  // ── GitHub: track source repo when user is on a GitHub tab ─────────────
  if (message.type === MSG.GH_MARK_SEEN) {
    const { url } = message.payload || {}
    if (url) addSeenJob(url).catch(() => {})
    return false
  }

  // ── GitHub tab reporting its pending-new count ──────────────────────────
  if (message.type === MSG.SOURCE_READY) {
    const tabId = sender.tab?.id
    if (!tabId) return false
    const { repo, pending } = message.payload || {}
    _sources.set(tabId, { tabId, repo, pending })
    broadcastSources()
    return false
  }

  // ── Control panel: give me the current known sources ────────────────────
  if (message.type === MSG.REQUEST_SOURCES) {
    sendResponse({ sources: [..._sources.values()] })
    return false
  }

  // ── Control panel: user picked which source tab to auto-apply from ─────
  if (message.type === MSG.PICK_SOURCE) {
    const { tabId } = message.payload || {}
    if (!tabId) return false
    chrome.tabs.update(tabId, { active: true }, () => {
      chrome.tabs.sendMessage(tabId, { type: MSG.START_QUEUE }).catch(() => {})
    })
    return false
  }
})

// Store source repo label when a GitHub tab navigates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  if (!tab.url) return
  const REPOS = [
    { match: 'zapplyjobs/Internships-2027',    label: 'Internships-2027' },
    { match: 'sndsh404/summer-2027-internships', label: 'summer-2027-internships' },
    { match: 'SimplifyJobs/Summer2026-Internships', label: 'Summer2026-Internships' },
  ]
  for (const r of REPOS) {
    if (tab.url.toLowerCase().includes(r.match.toLowerCase())) {
      chrome.storage.local.set({ ghSourceRepo: r.label })
      return
    }
  }
})

// ── Claude API helpers ────────────────────────────────────────────────────────

function findLocalAnswer(question, answers) {
  const lower = (question || '').toLowerCase().trim()
  for (const entry of (answers || [])) {
    if ((entry.patterns || []).some(p => lower.includes(p.toLowerCase()))) {
      return entry.answer
    }
  }
  return null
}

async function handleClaudeRequest({ question, fieldContext, fieldLabel }) {
  const profile = await getProfile()
  const answers = await getAnswers()
  const local   = findLocalAnswer(question || fieldLabel, answers)
  if (local !== null) return { suggestion: local }

  const apiKey = profile.claudeApiKey
  if (!apiKey || !apiKey.trim()) return { error: 'NO_API_KEY' }

  const systemPrompt = buildSystemPrompt(profile)
  const userPrompt   = buildUserPrompt(question || fieldLabel, fieldContext)

  let response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey.trim(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    })
  } catch (err) {
    return { error: 'NETWORK_ERROR: ' + err.message }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return { error: `API_ERROR ${response.status}: ${body}` }
  }

  const data       = await response.json()
  const suggestion = data.content?.[0]?.text?.trim() || ''
  return { suggestion }
}

function buildFitAnalysisPrompt(profile, jobDescription) {
  const name   = `${profile.firstName || ''} ${profile.lastName || ''}`.trim()
  const yrs    = profile.yearsOfExperience || 1
  const degree = [profile.highestDegree, profile.fieldOfStudy, profile.university].filter(Boolean).join(' in ')

  return `Evaluate whether this candidate should apply to this internship/job.

CANDIDATE:
Name: ${name}
Degree: ${degree}${profile.gpa ? ` (GPA: ${profile.gpa})` : ''}
Years of experience: ${yrs}
Skills: ${(profile.skills || '').slice(0, 300)}${profile.workExperience ? `\nWork: ${profile.workExperience.slice(0, 400)}` : ''}

PAGE TEXT (the whole page's visible text — a real job description is in
here somewhere, along with nav/footer/cookie-banner noise; ignore the noise):
${(jobDescription || '').slice(0, 6000)}

---
On the very first line write only YES (apply) or NO (skip), then on separate lines:

FIELD: YES (job is in a STEM/tech field) or NO
DEGREE: YES (candidate's degree qualifies) or NO
PAID: YES (this is a paid position) or NO
EXPERIENCE: YES (experience requirement is ≤${yrs + 1} year(s)) or NO
REASON: one-sentence explanation`
}

// ── Fit check via the claude.ai project tab (no API key needed) ──────────────
//
// Targets exactly one claude.ai tab directly via MSG.RUN_CLAUDE_JOB_ANALYSIS
// (found with chrome.tabs.query, a read-only/reliable call), which tells
// claude.js to redirect itself to the project — via plain window.location.href,
// not chrome.tabs.update — if it isn't there already, then send the prompt
// and parse the reply into claudeJobResult. Falls back to broadcasting via
// storage only if no claude.ai tab is found at all (rare — the app always
// opens one at startup). Deliberately no chrome.tabs.create/update here:
// that extension-tabs-API navigation doesn't reliably produce a real window
// action in this Electron shell (see MSG.OPEN_JOB_URL).

const CLAUDE_PROJECT_URL = 'https://claude.ai/project/019ead72-f6d6-74aa-84ee-5c652fd866d0'
const CLAUDE_FIT_TIMEOUT_MS = 180000

function waitForClaudeJobResult(timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      chrome.storage.onChanged.removeListener(listener)
      clearTimeout(timer)
      resolve(result)
    }
    const listener = (changes, area) => {
      if (area === 'local' && changes.claudeJobResult) finish(changes.claudeJobResult.newValue)
    }
    chrome.storage.onChanged.addListener(listener)
    const timer = setTimeout(() => finish({ error: 'TIMEOUT', decision: 'SKIP' }), timeoutMs)
  })
}

function findClaudeTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
      resolve(tabs && tabs.length > 0 ? tabs[0].id : null)
    })
  })
}

async function askClaudeViaTabInner(prompt) {
  await chrome.storage.local.remove('claudeJobResult')
  const resultPromise = waitForClaudeJobResult(CLAUDE_FIT_TIMEOUT_MS)

  const tabId = await findClaudeTabId()
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: MSG.RUN_CLAUDE_JOB_ANALYSIS, payload: { prompt } }).catch(() => {})
  } else {
    // No claude.ai tab found — fall back to a global broadcast so whichever
    // tab loads next (or already exists but wasn't picked up by the query) gets it.
    await chrome.storage.local.set({ pendingClaudeJobAnalysis: prompt })
  }

  const result = await resultPromise
  await chrome.storage.local.remove('claudeJobResult')
  return result
}

// claudeJobResult/pendingClaudeJobAnalysis are single global storage keys, so
// two fit-checks in flight at once would stomp on each other — serialize them.
let _claudeChain = Promise.resolve()
function askClaudeViaTab(prompt) {
  const result = _claudeChain.then(() => askClaudeViaTabInner(prompt))
  _claudeChain = result.catch(() => {})
  return result
}

async function handleFitCheck({ jobDescription }) {
  const profile = await getProfile()
  const prompt  = buildFitAnalysisPrompt(profile, jobDescription)
  const result  = await askClaudeViaTab(prompt)

  if (result?.error) return { error: result.error }

  const isApply = result.decision === 'APPLY'
  const missing = Object.entries(result.criteria || {})
    .filter(([, v]) => v === 'NO')
    .map(([k]) => k)

  return {
    decision:       isApply ? 'YES' : 'NO',
    score:          isApply ? 8 : 2,
    scoreLabel:     isApply ? 'Apply' : 'Skip',
    matching:       [],
    missing,
    recommendation: result.reason || (isApply ? 'Claude says: Apply' : 'Claude says: Skip'),
  }
}

// ── Scan-my-answers: turn manually-typed form values into answers.json ───────

function buildAnswerScanPrompt(fields) {
  const qa = fields.map(f => `Q: ${f.label}\nA: ${f.value}`).join('\n\n')

  return `I just manually filled out a job application form myself. Convert each answer below into a reusable Q&A entry for my answers database, so future application forms with similar questions can be auto-filled without asking me again.

${qa}

Respond with ONLY a JSON array (no other text, wrapped in a single \`\`\`json code block), one entry per question, in this exact shape:
[{"patterns": ["short lowercase phrase(s) that would match similar future questions"], "answer": "the answer text, cleaned up if needed"}]

Skip entries where the answer is just a placeholder, or is specific to only this one company/role and wouldn't make sense reused elsewhere.`
}

function waitForClaudeAnswerScanResult(timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      chrome.storage.onChanged.removeListener(listener)
      clearTimeout(timer)
      resolve(result)
    }
    const listener = (changes, area) => {
      if (area === 'local' && changes.claudeAnswerScanResult) finish(changes.claudeAnswerScanResult.newValue)
    }
    chrome.storage.onChanged.addListener(listener)
    const timer = setTimeout(() => finish({ error: 'TIMEOUT' }), timeoutMs)
  })
}

async function askClaudeForAnswerScanInner(prompt) {
  await chrome.storage.local.remove('claudeAnswerScanResult')
  const resultPromise = waitForClaudeAnswerScanResult(CLAUDE_FIT_TIMEOUT_MS)

  const tabId = await findClaudeTabId()
  if (!tabId) return { error: 'NO_CLAUDE_TAB' }
  chrome.tabs.sendMessage(tabId, { type: MSG.RUN_CLAUDE_ANSWER_SCAN, payload: { prompt } }).catch(() => {})

  const result = await resultPromise
  await chrome.storage.local.remove('claudeAnswerScanResult')
  return result
}

// Shares _claudeChain with askClaudeViaTab — both talk to the same claude.ai
// tab/editor, so a job-fit check and an answer-scan must never overlap.
function askClaudeForAnswerScan(prompt) {
  const result = _claudeChain.then(() => askClaudeForAnswerScanInner(prompt))
  _claudeChain = result.catch(() => {})
  return result
}

// Merge new {patterns, answer} entries into the existing answers DB —
// replacing any existing entry that shares a pattern, appending otherwise.
async function mergeAnswerEntries(newEntries) {
  const existing = await getAnswers()
  for (const entry of newEntries) {
    if (!entry?.answer || !Array.isArray(entry.patterns) || entry.patterns.length === 0) continue
    const patterns = entry.patterns.map(p => String(p).toLowerCase().trim()).filter(Boolean)
    if (!patterns.length) continue

    const idx = existing.findIndex(e => (e.patterns || []).some(p => patterns.includes(String(p).toLowerCase())))
    if (idx >= 0) existing[idx] = { patterns, answer: String(entry.answer) }
    else existing.push({ patterns, answer: String(entry.answer) })
  }
  await chrome.storage.local.set({ answers: existing })
  return existing
}

async function handleScanAnswers({ fields }) {
  if (!Array.isArray(fields) || fields.length === 0) return { error: 'NO_FIELDS' }

  const prompt = buildAnswerScanPrompt(fields)
  const result = await askClaudeForAnswerScan(prompt)
  if (result?.error) return { error: result.error }

  let parsed
  try {
    parsed = JSON.parse(result.json)
  } catch {
    return { error: 'PARSE_FAILED' }
  }
  if (!Array.isArray(parsed)) return { error: 'PARSE_FAILED' }

  const merged = await mergeAnswerEntries(parsed)

  try {
    // Persist to credentials/answers.json via the Electron helper — chrome.storage
    // alone would be wiped/overwritten on the next credential reseed.
    await fetch(`http://127.0.0.1:${SHEETS_PORT}/save-answers`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ entries: merged }),
    })
  } catch {
    // Electron helper not running — storage is still updated either way.
  }

  return { saved: parsed.length }
}

function buildSystemPrompt(profile) {
  const name     = `${profile.firstName} ${profile.lastName}`.trim()
  const gradDate = `${profile.graduationMonth || 'May'} ${profile.graduationYear || '2027'}`

  return [
    `You are helping ${name || 'a job applicant'} fill out a job application form.`,
    `Answer questions in first person as if you are the applicant.`,
    `Keep answers concise — 1–3 sentences unless the question clearly requires more.`,
    `Do not fabricate specific facts not provided below.`,
    ``,
    `APPLICANT PROFILE:`,
    `- Name: ${name}`,
    `- Email: ${profile.email}`,
    `- Phone: ${profile.phone}`,
    `- Location: ${profile.city}, ${profile.state}`,
    `- Current title: ${profile.currentTitle}`,
    `- Years of experience: ${profile.yearsOfExperience}`,
    `- Work authorization: ${profile.workAuthorization} — authorized to work in the US: Yes; requires sponsorship: No`,
    `- Education: ${profile.highestDegree} in ${profile.fieldOfStudy} from ${profile.university}, GPA: ${profile.gpa}, graduating ${gradDate}`,
    `- Currently a full-time student: Yes`,
    `- Prior internship/co-op experience: Yes (4 internships completed)`,
    `- Willing to relocate: No`,
    `- Can work on-site: Yes`,
    `- Available start date: ${profile.availableStartDate || 'June 2026'}`,
    `- How heard about role: ${profile.referralSource || 'GitHub'}`,
    `- Skills: ${profile.skills}`,
    profile.professionalSummary && `- Summary: ${profile.professionalSummary}`,
    profile.workExperience      && `\nWORK EXPERIENCE:\n${profile.workExperience}`,
    profile.projects            && `\nPROJECTS:\n${profile.projects}`,
    profile.relevantCoursework  && `\nRELEVANT COURSEWORK: ${profile.relevantCoursework}`,
  ].filter(Boolean).join('\n')
}

function buildUserPrompt(question, fieldContext) {
  let prompt = `Job application question: "${question}"`
  if (fieldContext) prompt += `\n\nContext from the form: ${fieldContext}`
  prompt += `\n\nProvide a concise, professional answer suitable for a job application form field.`
  return prompt
}
