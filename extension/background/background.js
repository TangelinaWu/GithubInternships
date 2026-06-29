// Background page — GH Internships extension
// Handles: fit checks via Claude API, sheets logging, overlay Q&A, seen-URL sync

const SHEETS_PORT = 3743

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Fit check (Claude API) ──────────────────────────────────────────────
  if (message.type === MSG.CHECK_FIT) {
    handleFitCheck(message.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }))
    return true
  }

  // ── ATS assessor: new job detected ─────────────────────────────────────
  if (message.type === MSG.GH_ASSESSING) {
    // Track source tab so GH_DO_APPLY/GH_DO_SKIP can be routed back
    if (sender.tab?.id) {
      chrome.storage.local.set({ ghAssessingTabId: sender.tab.id })
    }
    // Forward to control panel
    chrome.runtime.sendMessage(message).catch(() => {})
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
  if ([MSG.AUTO_APPLY_STARTED, MSG.AUTO_APPLY_FILLING, MSG.AUTO_APPLY_COMPLETE].includes(message.type)) {
    chrome.runtime.sendMessage(message).catch(() => {})
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

async function handleFitCheck({ jobDescription }) {
  const profile = await getProfile()
  const apiKey  = profile.claudeApiKey
  if (!apiKey || !apiKey.trim()) return { error: 'NO_API_KEY' }

  const name = `${profile.firstName} ${profile.lastName}`.trim()
  const profileText = [
    `Name: ${name}`,
    `Title: ${profile.currentTitle}`,
    `Years of experience: ${profile.yearsOfExperience}`,
    `Education: ${profile.highestDegree} in ${profile.fieldOfStudy} from ${profile.university}` +
      (profile.gpa ? ` (GPA: ${profile.gpa})` : ''),
    `Skills: ${profile.skills}`,
    profile.certifications      && `Certifications: ${profile.certifications}`,
    profile.relevantCoursework  && `Relevant coursework: ${profile.relevantCoursework}`,
    profile.workExperience      && `Work experience:\n${profile.workExperience}`,
    profile.projects            && `Projects:\n${profile.projects}`,
    profile.professionalSummary && `Summary: ${profile.professionalSummary}`,
  ].filter(Boolean).join('\n')

  const prompt = `You are evaluating a job candidate's fit for an internship or job.

HARD DISQUALIFIERS — check first. If ANY apply, set score to 0, scoreLabel to "Disqualified", and put the reason in recommendation:
• Requires Master's or PhD and does NOT accept a Bachelor's degree
• Requires more years of experience than the candidate has (${profile.yearsOfExperience || 1} year(s))
• Unpaid, academic credit only, or volunteer position
• Has an age requirement or age range restriction
• Requires a non-STEM degree specifically (CS, Engineering, Data Science, Math, Physics, or any STEM field is fine)

CANDIDATE:
${profileText}

JOB DESCRIPTION:
${(jobDescription || '').slice(0, 3500)}

Reply with a raw JSON object (no markdown fences):
{
  "score": <integer 0-10>,
  "scoreLabel": "<Disqualified | Weak Match | Fair Match | Good Match | Strong Match | Excellent Match>",
  "matching": [<up to 5 short strings: skills the candidate has that match>],
  "missing": [<up to 5 short strings: requirements the candidate doesn't clearly meet>],
  "recommendation": "<one sentence on whether to apply and why>"
}`

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
        max_tokens: 500,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })
  } catch (err) {
    return { error: 'NETWORK_ERROR: ' + err.message }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return { error: `API_ERROR ${response.status}: ${body}` }
  }

  const data = await response.json()
  const text = data.content?.[0]?.text?.trim() || ''
  try {
    return JSON.parse(text)
  } catch {
    return { error: 'PARSE_ERROR', raw: text }
  }
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
