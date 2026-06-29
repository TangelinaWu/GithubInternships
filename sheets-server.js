'use strict'
const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const PORT        = 3743   // different from JobApplier (3742) so both can run simultaneously
const CREDS_FILE  = path.join(__dirname, 'credentials', 'sheets-credentials.json')
const CONFIG_FILE = path.join(__dirname, 'credentials', 'sheets-config.json')

const APPLIED_SHEET  = 'GH Applied'
const SKIPPED_SHEET  = 'GH Skipped'

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

  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${sheetName}!A1`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await resp.json()
  if (data.values?.[0]?.[0] !== headers[0]) {
    const endCol = String.fromCharCode(64 + headers.length)
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${sheetName}!A1:${endCol}1?valueInputOption=USER_ENTERED`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ values: [headers] }),
      }
    )
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

function startServer() {
  const enabled = loadConfig()

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

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

    res.writeHead(404); res.end()
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Sheets] GH Internships server listening on http://127.0.0.1:${PORT}`)
  })

  return server
}

module.exports = { startServer }
