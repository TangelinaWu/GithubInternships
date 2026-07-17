'use strict'
const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
// Reused directly from the sibling JobApplier project — never fork/duplicate this
// module. Its tailoring prompt, 1-page constraints, and Jake's-format renderer are
// Angelina's own requirements and must stay identical across both apps.
const tailorEngine = require('../JobApplier/resume_tailor/tailorEngine')

const PORT        = 3743   // different from JobApplier (3742) so both can run simultaneously
const MASTER_RESUME_FILE = path.join(__dirname, 'credentials', 'master_resume.json')
const RESUMES_DIR        = path.join(__dirname, 'resume')

// Physical-click bridge: electron-main.js registers a handler here so content
// scripts can request a native OS-level click via HTTP (no Playwright needed).
let _physicalClickHandler = null
function setPhysicalClickHandler(fn) { _physicalClickHandler = fn }

// Save-answers bridge: electron-main.js registers a handler here so the
// extension can persist updated Q&A entries to credentials/answers.json
// (chrome.storage has no filesystem access — only the main process does).
let _saveAnswersHandler = null
function setSaveAnswersHandler(fn) { _saveAnswersHandler = fn }

let _mainWindow = null
function setMainWindow(win) { _mainWindow = win }
const CREDS_FILE  = path.join(__dirname, 'credentials', 'sheets-credentials.json')
const CONFIG_FILE = path.join(__dirname, 'credentials', 'sheets-config.json')

const APPLIED_SHEET  = 'GH Applied'
const SKIPPED_SHEET  = 'GH Skipped'

// Master tracker tab — one row per application the moment it's opened for
// filling, so nothing that was attempted goes unlogged even if the fill
// fails or the user finishes it by hand. Status starts as 'N/A' and only
// flips to 'Applied' / 'Skip' once the existing LOG_APPLICATION flow
// (auto-complete or a manual "I Applied"/"Skip" click) reports a decision.
const GITHUB_SHEET   = 'Github Internships'

// Columns for the Applied sheet
const APPLIED_HEADERS = [
  'Timestamp', 'Company', 'Role', 'Source Repo',
  'Application URL', 'Status', 'Pay', 'Location',
  'Full Time', 'Claude Score', 'Score Label',
  'Matching Skills', 'Missing Skills', 'Notes',
]

// Columns for the Skipped sheet
const SKIPPED_HEADERS = [
  'Timestamp', 'Company', 'Role', 'Source Repo', 'Application URL', 'Reason',
]

// Columns for the master tracker sheet. Status is column A so it's always
// the first thing visible; Application URL (col F) is the lookup key used
// to find a row again when the decision comes in later.
// H–K are written by the 3-script pipeline: parse → resume → scan.
const GITHUB_HEADERS = [
  'Status', 'Timestamp', 'Company', 'Role', 'Co-op Date', 'Application URL', 'Description',
  'Fit', 'Fit Reason', 'Resume', 'Applied',
]

let _creds          = null
let _spreadsheetId  = null
let _token          = null
let _tokenExpiry    = 0
let _headersEnsured = {}

function loadConfig() {
  try {
    _creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    _spreadsheetId = config.spreadsheetId
    console.log('[Sheets] Loaded credentials for sheet:', _spreadsheetId)
    return true
  } catch {
    console.warn('[Sheets] credentials not found — Sheets disabled')
    return false
  }
}

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry) return _token

  const now     = Math.floor(Date.now() / 1000)
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss:   _creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })).toString('base64url')

  const sigInput = `${header}.${payload}`
  const signer   = crypto.createSign('RSA-SHA256')
  signer.update(sigInput)
  const sig = signer.sign(_creds.private_key).toString('base64url')

  const jwt  = `${sigInput}.${sig}`
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Token error ${resp.status}: ${text}`)
  }

  const { access_token, expires_in } = await resp.json()
  _token       = access_token
  _tokenExpiry = Date.now() + (Number(expires_in) - 60) * 1000
  return _token
}

async function ensureSheet(token, sheetName) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data   = await resp.json()
  const exists = data.sheets?.some(s => s.properties?.title === sheetName)
  if (!exists) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}:batchUpdate`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
      }
    )
    console.log(`[Sheets] Created sheet tab: ${sheetName}`)
  }
}

async function ensureHeaderRow(token, sheetName, headers) {
  if (_headersEnsured[sheetName]) return
  await ensureSheet(token, sheetName)

  const endCol = String.fromCharCode(64 + headers.length)
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:${endCol}1`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data     = await resp.json()
  const existing = data.values?.[0] || []
  // Rewrite whenever the first cell or the column count doesn't match.
  if (existing[0] !== headers[0] || existing.length < headers.length) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:${endCol}1?valueInputOption=USER_ENTERED`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ values: [headers] }),
      }
    )
    console.log(`[Sheets] Updated header row for ${sheetName} (${headers.length} cols)`)
  }
  _headersEnsured[sheetName] = true
}

// Extract hourly pay / stipend from description
function extractPay(description) {
  if (!description) return ''
  const patterns = [
    /\$[\d,]+(?:\.\d+)?\s*\/\s*(?:hour|hr|h)\b/i,
    /[\d,]+(?:\.\d+)?\s*(?:USD|dollars?)\s*\/\s*(?:hour|hr)\b/i,
    /\$[\d,]+(?:\.\d+)?\s*(?:per\s+hour|hourly)/i,
    /\$[\d,]+(?:k)?\s*\/\s*(?:year|yr|annual)/i,
    /\$[\d,]+(?:,\d+)?\s*(?:stipend|salary)/i,
    /stipend\s*(?:of\s*)?\$[\d,]+/i,
  ]
  for (const p of patterns) {
    const m = description.match(p)
    if (m) return m[0].trim()
  }
  return ''
}

// Extract location from description
function extractLocation(description) {
  if (!description) return ''
  const m = description.match(/(?:location|based in|office in|on-?site in|remote\s*\/?\s*hybrid)?[:\s]+([A-Z][a-zA-Z\s]+,\s*[A-Z]{2})/m)
  if (m) return m[1].trim()
  if (/\bremote\b/i.test(description)) return 'Remote'
  return ''
}

// Detect if position is full time, part time, or internship
function detectJobType(description) {
  if (!description) return 'Internship'
  if (/\bfull[- ]?time\b/i.test(description) && !/internship/i.test(description)) return 'Full Time'
  if (/\bpart[- ]?time\b/i.test(description)) return 'Part Time'
  return 'Internship'
}

// Extract the co-op/internship term (e.g. "Fall 2026") from the role title
// or description.
function extractTerm(role, description) {
  const m = `${role || ''} ${description || ''}`.match(/\b(Spring|Summer|Fall|Winter)\s*20\d{2}\b/i)
  return m ? m[0].replace(/\s+/g, ' ').trim() : ''
}

// Find the 1-indexed sheet row (within the data rows, i.e. row 2+) whose
// Application URL column matches `url`. Returns null if not found.
async function findGithubInternshipsRow(token, url) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(GITHUB_SHEET)}!F2:F`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await resp.json()
  const urls = (data.values || []).flat()
  const idx  = urls.findIndex(u => u === url)
  return idx === -1 ? null : idx + 2
}

async function appendGithubInternshipsRow(token, entry, status) {
  await ensureHeaderRow(token, GITHUB_SHEET, GITHUB_HEADERS)

  const row = [
    status,
    new Date().toLocaleString(),
    entry.company || '',
    entry.role    || '',
    extractTerm(entry.role, entry.description),
    entry.url     || '',
    (entry.description || '').slice(0, 500),
  ]

  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(GITHUB_SHEET)}!A:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [row] }),
    }
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Append error ${resp.status}: ${text}`)
  }
}

// Log an application the moment it's opened for filling — Status starts as
// 'N/A' and is only flipped once a decision (Applied/Skip) comes in. Skipped
// if a row for this URL already exists (auto-apply can hop across tabs and
// re-fire the "opened" signal for the same job).
async function logOpened(entry) {
  if (!entry.url) return
  const token = await getAccessToken()
  await ensureHeaderRow(token, GITHUB_SHEET, GITHUB_HEADERS)

  const existingRow = await findGithubInternshipsRow(token, entry.url)
  if (existingRow) return

  await appendGithubInternshipsRow(token, entry, 'N/A')
  console.log(`[Sheets] Logged opened application: ${entry.company} / ${entry.role}`)
}

// Flip the tracker row's Status to 'Applied' or 'Skip' once a decision comes
// in. Falls back to appending a full row if no 'opened' row was logged for
// this URL (e.g. it was applied to outside the auto-apply pipeline).
async function syncGithubInternshipsStatus(entry) {
  if (!entry.url) return
  const status = entry.decision === 'APPLIED' ? 'Applied'
    : entry.decision === 'SKIPPED' ? 'Skip'
    : null
  if (!status) return

  const token = await getAccessToken()
  await ensureHeaderRow(token, GITHUB_SHEET, GITHUB_HEADERS)

  const sheetRow = await findGithubInternshipsRow(token, entry.url)
  if (!sheetRow) {
    await appendGithubInternshipsRow(token, entry, status)
    return
  }

  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(GITHUB_SHEET)}!A${sheetRow}?valueInputOption=USER_ENTERED`,
    {
      method:  'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [[status]] }),
    }
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Status update error ${resp.status}: ${text}`)
  }
  console.log(`[Sheets] Marked ${status} in ${GITHUB_SHEET}: ${entry.company} / ${entry.role}`)
}

async function appendRow(entry) {
  const token    = await getAccessToken()
  const isApplied = entry.decision === 'APPLIED'
  const sheetName = isApplied ? APPLIED_SHEET : SKIPPED_SHEET
  const headers   = isApplied ? APPLIED_HEADERS : SKIPPED_HEADERS

  await ensureHeaderRow(token, sheetName, headers)

  const timestamp = new Date().toLocaleString()
  const desc      = entry.description || ''

  const row = isApplied
    ? [
        timestamp,
        entry.company      || '',
        entry.role         || '',
        entry.sourceRepo   || '',
        entry.url          || '',
        'Applied',
        extractPay(desc),
        entry.location     || extractLocation(desc),
        detectJobType(desc),
        entry.score        != null ? String(entry.score) : '',
        entry.scoreLabel   || '',
        (entry.matching    || []).join(', '),
        (entry.missing     || []).join(', '),
        entry.reason       || '',
      ]
    : [
        timestamp,
        entry.company    || '',
        entry.role       || '',
        entry.sourceRepo || '',
        entry.url        || '',
        entry.reason     || '',
      ]

  const endCol = String.fromCharCode(64 + row.length)
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${sheetName}!A:${endCol}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [row] }),
    }
  )

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Append error ${resp.status}: ${text}`)
  }

  console.log(`[Sheets] Logged to ${sheetName}: ${entry.decision} — ${entry.company} / ${entry.role}`)

  // Flip the master tracker's Status and — for APPLIED decisions — mark col K.
  syncGithubInternshipsStatus(entry).catch(e =>
    console.error('[Sheets] syncGithubInternshipsStatus error:', e.message)
  )
  if (entry.decision === 'APPLIED' && entry.url) {
    markApplied(entry.url).catch(e =>
      console.error('[Sheets] markApplied error:', e.message)
    )
  }

  // Notify scan-main.js (or any other listener) that a job was logged.
  for (const fn of _onLogCallbacks) {
    try { fn(entry) } catch {}
  }
}

async function getSeenUrls() {
  const token = await getAccessToken()
  // Applied: URL is col E (index 5). Skipped: URL is col E (index 5).
  const [appliedResp, skippedResp] = await Promise.all([
    fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${APPLIED_SHEET}!E2:E`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json()).catch(() => ({ values: [] })),
    fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${SKIPPED_SHEET}!E2:E`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json()).catch(() => ({ values: [] })),
  ])
  const appliedUrls = (appliedResp.values || []).flat().filter(Boolean)
  const skippedUrls = (skippedResp.values  || []).flat().filter(Boolean)
  return [...new Set([...appliedUrls, ...skippedUrls])]
}

// ── Pipeline column helpers ───────────────────────────────────────────────────
// Col J (index 9)  = Resume   — filename, written by npm run resume
// Col K (index 10) = Applied  — 'Yes', written by npm run scan

async function updateGithubCol(url, colLetter, value) {
  if (!url) return
  const token    = await getAccessToken()
  const sheetRow = await findGithubInternshipsRow(token, url)
  if (!sheetRow) return
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(GITHUB_SHEET)}!${colLetter}${sheetRow}?valueInputOption=USER_ENTERED`,
    {
      method:  'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [[value]] }),
    }
  )
}

async function markResumeReady(url, fileName) {
  await updateGithubCol(url, 'J', fileName || 'Yes')
  console.log(`[Sheets] Resume marked for: ${url}`)
}

async function markApplied(url) {
  await updateGithubCol(url, 'K', 'Yes')
  console.log(`[Sheets] Applied marked for: ${url}`)
}

// Returns rows where Resume (col J) is filled AND Applied (col K) is empty.
// Caller must have called loadConfig() / startServer() first.
async function getScanQueue() {
  const token = await getAccessToken()
  await ensureHeaderRow(token, GITHUB_SHEET, GITHUB_HEADERS)
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(GITHUB_SHEET)}!A2:K`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await resp.json()
  return (data.values || [])
    .map((row, i) => ({
      rowNum:     i + 2,
      company:    row[2]  || '',
      role:       row[3]  || '',
      url:        row[5]  || '',
      resumeFile: row[9]  || '',   // col J
      applied:    row[10] || '',   // col K
    }))
    .filter(r => r.url && r.resumeFile && !r.applied)
}

// ── Log callbacks (used by scan-main.js to sequence jobs) ────────────────────
// Fired whenever appendRow() completes, with the full entry object.

let _onLogCallbacks = []
// Returns a remove function so callers can unregister after the job resolves.
function setOnLogCallback(fn) {
  _onLogCallbacks.push(fn)
  return () => { _onLogCallbacks = _onLogCallbacks.filter(cb => cb !== fn) }
}

// Sanitize a company/role string into a safe filename fragment.
function slugify(str) {
  return String(str || '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'untitled'
}

// Mirrors JobApplier's job_automation/sheets-server.js tailorResumeForJob —
// asks Claude (via tailorEngine's own hidden claude.ai window) to tailor the
// master resume to this job description, renders it to PDF, and saves it into
// resume/. Returns { pdfPath, pdfDataUrl, fileName, fitScore, fitReason }.
async function tailorResumeForJob({ jobDescription, jobTitle, company }) {
  if (!fs.existsSync(MASTER_RESUME_FILE)) {
    throw new Error('credentials/master_resume.json not found')
  }
  const masterResume = JSON.parse(fs.readFileSync(MASTER_RESUME_FILE, 'utf8'))

  // Full page text can be 10k+ chars — truncate to keep the prompt manageable
  const truncatedDesc = jobDescription.slice(0, 4000)
  console.log(`[ResumeTailor] jobDescription length: ${jobDescription.length} → truncated to ${truncatedDesc.length}`)

  const parentWindow = _mainWindow && !_mainWindow.isDestroyed() ? _mainWindow : null
  const result = await tailorEngine.runTailorFlow({ jobDescription: truncatedDesc, masterResume, show: false, parentWindow })
  const state  = tailorEngine.buildStateFromResult(masterResume, result)
  const html   = tailorEngine.buildJakesHTML(state)
  const pdfBuffer = await tailorEngine.renderResumeToPdfBuffer(html)

  if (!fs.existsSync(RESUMES_DIR)) fs.mkdirSync(RESUMES_DIR, { recursive: true })
  const fileName = `${slugify(company)}_${slugify(jobTitle)}_${Date.now()}.pdf`
  const pdfPath  = path.join(RESUMES_DIR, fileName)
  fs.writeFileSync(pdfPath, pdfBuffer)

  return {
    pdfPath,
    fileName,
    pdfDataUrl: `data:application/pdf;base64,${pdfBuffer.toString('base64')}`,
    fitScore: result.fitScore,
    fitReason: result.fitReason,
  }
}

function startServer() {
  const enabled = loadConfig()

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Physical-click: available regardless of Sheets configuration
    if (req.method === 'POST' && req.url === '/physical-click') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        let url
        try { ({ url } = JSON.parse(body)) } catch {}
        if (!url || !_physicalClickHandler) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'handler not registered' }))
          return
        }
        _physicalClickHandler(url)
          .then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          })
          .catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          })
      })
      return
    }

    // Save-answers: available regardless of Sheets configuration
    if (req.method === 'POST' && req.url === '/save-answers') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        let entries
        try { ({ entries } = JSON.parse(body)) } catch {}
        if (!Array.isArray(entries) || !_saveAnswersHandler) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'handler not registered' }))
          return
        }
        _saveAnswersHandler(entries)
          .then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          })
          .catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          })
      })
      return
    }

    // Resume tailoring works independently of Google Sheets configuration.
    if (req.method === 'POST' && req.url === '/tailor-resume') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        let payload
        try { payload = JSON.parse(body) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Bad JSON' }))
          return
        }
        if (!payload.jobDescription) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'jobDescription is required' }))
          return
        }
        tailorResumeForJob(payload)
          .then(out => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, ...out }))
          })
          .catch(e => {
            console.error('[ResumeTailor] tailorResumeForJob error:', e.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message }))
          })
      })
      return
    }

    if (!enabled) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Sheets not configured' }))
      return
    }

    if (req.method === 'POST' && req.url === '/log') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        let entry
        try { entry = JSON.parse(body) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Bad JSON' }))
          return
        }
        appendRow(entry)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          })
          .catch(e => {
            console.error('[Sheets] appendRow error:', e.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message }))
          })
      })
      return
    }

    if (req.method === 'POST' && req.url === '/log-opened') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        let entry
        try { entry = JSON.parse(body) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Bad JSON' }))
          return
        }
        logOpened(entry)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          })
          .catch(e => {
            console.error('[Sheets] logOpened error:', e.message)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message }))
          })
      })
      return
    }

    if (req.method === 'GET' && req.url === '/seen') {
      getSeenUrls()
        .then(urls => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ urls }))
        })
        .catch(e => {
          console.error('[Sheets] getSeenUrls error:', e.message)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        })
      return
    }

    // scan-main.js fetches this to know which jobs to open.
    if (req.method === 'GET' && req.url === '/scan-queue') {
      getScanQueue()
        .then(queue => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ queue }))
        })
        .catch(e => {
          console.error('[Sheets] getScanQueue error:', e.message)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        })
      return
    }

    res.writeHead(404); res.end()
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Sheets] GH Internships server listening on http://127.0.0.1:${PORT}`)
  })

  return server
}

module.exports = {
  startServer,
  setPhysicalClickHandler,
  setSaveAnswersHandler,
  setMainWindow,
  setOnLogCallback,
  getScanQueue,
  markResumeReady,
  markApplied,
  loadConfig,
}
