'use strict'
// Shared Google Sheets API helpers used by parse.js and resume-main.js.
// scan-main.js uses sheets-server.js directly (already has its own auth).

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const ROOT        = path.join(__dirname, '..', '..')
const CREDS_FILE  = path.join(ROOT, 'credentials', 'sheets-credentials.json')
const CONFIG_FILE = path.join(ROOT, 'credentials', 'sheets-config.json')

let _creds, _spreadsheetId, _token, _tokenExpiry = 0

function loadConfig() {
  _creds         = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
  const cfg      = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  _spreadsheetId = cfg.spreadsheetId
}

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry) return _token
  const now    = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: _creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url')
  const sigInput = `${header}.${payload}`
  const signer   = crypto.createSign('RSA-SHA256')
  signer.update(sigInput)
  const sig = signer.sign(_creds.private_key).toString('base64url')
  const jwt = `${sigInput}.${sig}`
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  if (!resp.ok) throw new Error(`Token error ${resp.status}: ${await resp.text().catch(() => '')}`)
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
  const data = await resp.json()
  if (!data.sheets?.some(s => s.properties?.title === sheetName)) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}:batchUpdate`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
    })
  }
}

// Ensures the header row exists and has ALL expected columns.
// Writes (or rewrites) the full header if anything is missing.
async function ensureHeaders(token, sheetName, headers) {
  await ensureSheet(token, sheetName)
  const endCol = String.fromCharCode(64 + headers.length)
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:${endCol}1`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data     = await resp.json()
  const existing = data.values?.[0] || []
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
}

async function readRange(token, sheetName, range) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(sheetName)}!${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await resp.json()
  return data.values || []
}

async function appendRow(token, sheetName, values) {
  const endCol = String.fromCharCode(64 + values.length)
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:${endCol}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [values] }),
    }
  )
  if (!resp.ok) throw new Error(`Append error ${resp.status}: ${await resp.text().catch(() => '')}`)
}

async function updateCell(token, sheetName, cellRef, value) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${_spreadsheetId}/values/${encodeURIComponent(sheetName)}!${cellRef}?valueInputOption=USER_ENTERED`,
    {
      method:  'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [[value]] }),
    }
  )
  if (!resp.ok) throw new Error(`Update error ${resp.status}: ${await resp.text().catch(() => '')}`)
}

// Returns the 1-indexed row number (≥2) whose `colLetter` column matches `url`,
// or null if not found.
async function findRowByUrl(token, sheetName, url, colLetter = 'F') {
  const rows = await readRange(token, sheetName, `${colLetter}2:${colLetter}`)
  const idx  = rows.flat().findIndex(u => u === url)
  return idx === -1 ? null : idx + 2
}

module.exports = { loadConfig, getAccessToken, ensureHeaders, readRange, appendRow, updateCell, findRowByUrl }
