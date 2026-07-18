'use strict'
// npm run parse
// Fetches the first 10 new jobs from each GitHub internship repo, scores each
// against the same 4-gate criteria used by the extension (TIMING / SCAM /
// DEGREE / PAID) via the Claude API, and appends results to the
// "Github Internships" Google Sheet with Fit=Pass|Fail and a reason.
//
// Reads Claude API key from credentials/profile.json (claudeApiKey field)
// or from the CLAUDE_API_KEY environment variable.

const fs   = require('fs')
const path = require('path')

const sheets = require('./lib/sheets')

const ROOT         = path.join(__dirname, '..')
const PROFILE_FILE = path.join(ROOT, 'credentials', 'profile.json')

const GITHUB_SHEET = 'Github Internships'

// Full 11-column header — parse owns cols H & I; resume owns J; scan owns K.
const GITHUB_HEADERS = [
  'Status', 'Timestamp', 'Company', 'Role', 'Co-op Date',
  'Application URL', 'Description', 'Fit', 'Fit Reason', 'Resume', 'Applied',
]

const REPOS = [
  { name: 'zapplyjobs/Internships-2027',        branch: 'main', label: 'Internships-2027'       },
  { name: 'sndsh404/summer-2027-internships',    branch: 'main', label: 'summer-2027-internships' },
  { name: 'SimplifyJobs/Summer2026-Internships', branch: 'dev',  label: 'Summer2026-Internships'  },
]

const PARSE_LIMIT  = 10  // max new jobs processed per repo per run
const API_DELAY_MS = 700 // pause between Claude API calls to respect rate limits

// ── GitHub README fetching ────────────────────────────────────────────────────

async function fetchReadme(repoName, branch) {
  const url  = `https://raw.githubusercontent.com/${repoName}/${branch}/README.md`
  const resp = await fetch(url, { headers: { 'User-Agent': 'GHInternships-parser/1.0' } })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.text()
}

// ── Markdown table parser ─────────────────────────────────────────────────────

function extractLink(cellText) {
  const m = cellText.match(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/)
  return m ? m[2].trim() : null
}

function stripLinks(text) {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()
}

function stripEmoji(text) {
  return text.replace(/\p{Emoji_Presentation}/gu, '').replace(/\s+/g, ' ').trim()
}

// Extract all jobs from one or more markdown tables in a README string.
function parseReadmeJobs(text) {
  // Strip HTML tags (e.g. <details>, <summary>, <!-- comments -->) so they
  // don't confuse the pipe-line parser.
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')

  const lines = clean.split('\n')
  const jobs  = []
  let colMap  = null   // set on the header row, reused for data rows

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.startsWith('|')) { colMap = null; continue }

    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (!cells.length) continue

    // Separator row (| --- | --- | …)
    if (cells.every(c => /^[-:\s]+$/.test(c))) continue

    if (!colMap) {
      // Header row — map column names to indices
      colMap = {}
      cells.forEach((c, i) => {
        const lc = c.toLowerCase().replace(/[^a-z]/g, '')
        if (/company/.test(lc))              colMap.company  = i
        if (/role|position|title/.test(lc)) colMap.role     = i
        if (/location/.test(lc))             colMap.location = i
        if (/link|apply|application/.test(lc)) colMap.apply  = i
        if (/date|posted/.test(lc))          colMap.date     = i
      })
      // Positional fallbacks when keywords are absent
      if (colMap.company  === undefined) colMap.company  = 0
      if (colMap.role     === undefined) colMap.role     = 1
      if (colMap.location === undefined) colMap.location = 2
      if (colMap.apply    === undefined) colMap.apply    = cells.length - 1
      continue
    }

    // Skip locked rows
    if (line.includes('🔒')) continue

    const company  = stripEmoji(stripLinks(cells[colMap.company]  || ''))
    const role     = stripLinks(cells[colMap.role]     || '')
    const location = stripLinks(cells[colMap.location] || '')

    // Find the apply URL — scan columns right-to-left, skip repo/image links
    let url = null
    for (let i = cells.length - 1; i >= 0; i--) {
      const candidate = extractLink(cells[i])
      if (!candidate) continue
      if (/github\.com\/(zapplyjobs|sndsh404|SimplifyJobs)/i.test(candidate)) continue
      if (/\.(png|jpg|svg|gif)$/i.test(candidate)) continue
      url = candidate
      break
    }

    if (!company || !url) continue
    jobs.push({ company, role, location, url })
  }

  return jobs
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTerm(role) {
  const m = (role || '').match(/\b(Spring|Summer|Fall|Winter)\s*20\d{2}\b/i)
  return m ? m[0].replace(/\s+/g, ' ').trim() : ''
}

// ── Claude API fit assessment ─────────────────────────────────────────────────
// Uses the same 4-gate criteria (TIMING / SCAM / DEGREE / PAID) as the
// extension's buildFitAnalysisPrompt in background.js — kept in sync.

function buildFitPrompt(profile, job) {
  const name      = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'the candidate'
  const startDate = profile.availableStartDate || 'as soon as a good fit is found'
  const listing   = [
    `Company: ${job.company}`,
    `Role: ${job.role}`,
    job.location ? `Location: ${job.location}` : '',
  ].filter(Boolean).join('\n')

  return `I'm deciding whether to apply for this role. Check it against these four gate criteria ONLY — do NOT evaluate whether my skills/experience match the job description itself.

CRITERIA:
1. TIMING — is the role's timeline workable for a full-time undergrad available starting ${startDate}? A summer/semester internship or remote/flexible role is fine; a role demanding immediate full-time relocation during the school year is not.
2. SCAM — does this look like a legitimate posting with no scam red flags (payment requests, vague company info, unrealistic pay, pressure to leave platform, etc.)?
3. DEGREE — does this role accept a current undergraduate student with no requirement for an existing Bachelor's/Master's/PhD? (I'm ${name}, currently an undergrad at NYU.)
4. PAID — is this a paid position (not unpaid/volunteer/academic-credit-only)?

JOB LISTING:
${listing}

On the very first line write only YES (apply) or NO (skip), then on separate lines:

TIMING: YES or NO
SCAM: YES (no red flags) or NO
DEGREE: YES or NO
PAID: YES or NO
REASON: one-sentence explanation`
}

function parseFitResponse(text) {
  if (!text) return { fit: 'Fail', reason: 'No response from Claude' }
  const lines   = text.split('\n').map(l => l.trim())
  const verdict = lines.find(l => /^(YES|NO)\b/i.test(l))
  const reason  = (text.match(/REASON:\s*([^\n]+)/i)?.[1] || '').trim().slice(0, 220)
  return {
    fit:    verdict?.toUpperCase().startsWith('YES') ? 'Pass' : 'Fail',
    reason: reason || verdict || 'No reason given',
  }
}

async function callClaudeAPI(apiKey, prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    }),
  })
  if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${await resp.text().catch(() => '')}`)
  const data = await resp.json()
  return data.content?.[0]?.text || ''
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  sheets.loadConfig()

  // Load profile for fit prompt + API key
  let profile = {}
  if (fs.existsSync(PROFILE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'))
      profile = {
        firstName:          raw.firstName          || raw.personal?.firstName || '',
        lastName:           raw.lastName           || raw.personal?.lastName  || '',
        availableStartDate: raw.availableStartDate || raw.personal?.availableStartDate || 'June 2026',
        claudeApiKey:       raw.claudeApiKey       || '',
      }
    } catch (e) {
      console.warn('[parse] profile.json error:', e.message)
    }
  }

  const apiKey = profile.claudeApiKey || process.env.CLAUDE_API_KEY || ''
  if (!apiKey) {
    console.error('[parse] No Claude API key. Add claudeApiKey to credentials/profile.json or set CLAUDE_API_KEY.')
    process.exit(1)
  }

  const token = await sheets.getAccessToken()
  await sheets.ensureHeaders(token, GITHUB_SHEET, GITHUB_HEADERS)

  // Load all existing Application URLs so we don't duplicate rows
  const existingRows = await sheets.readRange(token, GITHUB_SHEET, 'F2:F')
  const seenUrls     = new Set(existingRows.flat().filter(Boolean))
  console.log(`[parse] ${seenUrls.size} URLs already in sheet`)

  let pass = 0, fail = 0

  for (const repo of REPOS) {
    console.log(`\n[parse] ── ${repo.label} ──`)

    let readme
    try {
      readme = await fetchReadme(repo.name, repo.branch)
    } catch {
      try {
        const alt = repo.branch === 'main' ? 'dev' : 'main'
        readme = await fetchReadme(repo.name, alt)
        console.log(`[parse]   (fell back to branch '${alt}')`)
      } catch (e2) {
        console.warn(`[parse] Could not fetch ${repo.name}: ${e2.message}`)
        continue
      }
    }

    const jobs = parseReadmeJobs(readme)
    console.log(`[parse] ${jobs.length} rows parsed from table`)

    let count = 0
    for (const job of jobs) {
      if (count >= PARSE_LIMIT) break
      if (!job.url || seenUrls.has(job.url)) continue

      count++
      seenUrls.add(job.url) // deduplicate within this run

      let fit = 'Fail', reason = 'Claude API error'
      try {
        const raw = await callClaudeAPI(apiKey, buildFitPrompt(profile, job))
        ;({ fit, reason } = parseFitResponse(raw))
      } catch (e) {
        console.warn(`[parse]   ✗ Claude error for ${job.company}: ${e.message}`)
      }

      const row = [
        '',                                                 // A: Status  (set later by scan)
        new Date().toLocaleString(),                        // B: Timestamp
        job.company,                                        // C: Company
        job.role,                                           // D: Role
        extractTerm(job.role),                              // E: Co-op Date
        job.url,                                            // F: Application URL
        `${job.role} — ${job.location || 'see listing'}`,  // G: Description
        fit,                                                // H: Fit
        reason,                                             // I: Fit Reason
        '',                                                 // J: Resume   (set by npm run resume)
        '',                                                 // K: Applied  (set by npm run scan)
      ]

      await sheets.appendRow(token, GITHUB_SHEET, row)
      console.log(`[parse]   ${fit.padEnd(4)} — ${job.company} — ${job.role}`)

      if (fit === 'Pass') pass++; else fail++

      await new Promise(r => setTimeout(r, API_DELAY_MS))
    }

    console.log(`[parse] ${count} new jobs processed from ${repo.label}`)
  }

  console.log(`\n[parse] Done — ${pass} Pass, ${fail} Fail`)
  process.exit(0)
}

main().catch(e => { console.error('[parse] Fatal:', e.message); process.exit(1) })
