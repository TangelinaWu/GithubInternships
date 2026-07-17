'use strict'
// npm run resume
// Reads "Github Internships" sheet for rows where Fit=Pass and Resume is empty,
// tailors a resume for each via tailorEngine (needs Electron for BrowserWindow),
// saves the PDF to resume/, and writes the filename to the Resume column (col J).
//
// Run: npm run resume
// Do NOT run simultaneously with npm start — they share the same Electron session.

const { app }  = require('electron')
const fs       = require('fs')
const path     = require('path')
const sheets   = require('./lib/sheets')
const tailorEngine = require(path.join(__dirname, '..', '..', 'JobApplier', 'resume_tailor', 'tailorEngine'))

const ROOT          = path.join(__dirname, '..')
const MASTER_RESUME = path.join(ROOT, 'credentials', 'master_resume.json')
const RESUMES_DIR   = path.join(ROOT, 'resume')
const GITHUB_SHEET  = 'Github Internships'

// Column indices in the sheet data rows (0-based)
const COL = { COMPANY: 2, ROLE: 3, URL: 5, DESC: 6, FIT: 7, RESUME: 9 }

function slugify(str) {
  return String(str || '').trim().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'untitled'
}

async function getResumeQueue(token) {
  const rows = await sheets.readRange(token, GITHUB_SHEET, 'A2:K')
  return rows
    .map((row, i) => ({
      rowNum:      i + 2,
      company:     row[COL.COMPANY] || '',
      role:        row[COL.ROLE]    || '',
      url:         row[COL.URL]     || '',
      description: row[COL.DESC]   || '',
      fit:         row[COL.FIT]    || '',
      resume:      row[COL.RESUME] || '',
    }))
    .filter(r => r.fit === 'Pass' && !r.resume && r.url)
}

app.whenReady().then(async () => {
  app.dock?.hide()  // suppress dock icon on macOS — headless run

  try {
    sheets.loadConfig()
    const token = await sheets.getAccessToken()
    const queue = await getResumeQueue(token)

    if (queue.length === 0) {
      console.log('[resume] No Pass rows with empty Resume column — nothing to do')
      app.quit()
      return
    }

    console.log(`[resume] ${queue.length} job(s) to tailor`)

    if (!fs.existsSync(MASTER_RESUME)) {
      console.error('[resume] credentials/master_resume.json not found')
      app.quit()
      return
    }

    const masterResume = JSON.parse(fs.readFileSync(MASTER_RESUME, 'utf8'))
    if (!fs.existsSync(RESUMES_DIR)) fs.mkdirSync(RESUMES_DIR, { recursive: true })

    for (const job of queue) {
      console.log(`[resume] Tailoring: ${job.company} — ${job.role}`)
      try {
        const desc = (job.description || `${job.role} at ${job.company}`).slice(0, 4000)

        const result    = await tailorEngine.runTailorFlow({ jobDescription: desc, masterResume, show: false, parentWindow: null })
        const state     = tailorEngine.buildStateFromResult(masterResume, result)
        const html      = tailorEngine.buildJakesHTML(state)
        const pdfBuffer = await tailorEngine.renderResumeToPdfBuffer(html)

        const fileName = `${slugify(job.company)}_${slugify(job.role)}_${Date.now()}.pdf`
        fs.writeFileSync(path.join(RESUMES_DIR, fileName), pdfBuffer)

        // Mark col J with the filename — scan-main.js uses this to locate the PDF.
        await sheets.updateCell(token, GITHUB_SHEET, `J${job.rowNum}`, fileName)

        console.log(`[resume] ✓ ${fileName} (fit ${result.fitScore ?? '?'}%)`)
      } catch (e) {
        console.error(`[resume] ✗ ${job.company}: ${e.message}`)
      }
    }

    console.log('[resume] Done')
  } catch (e) {
    console.error('[resume] Fatal:', e.message)
  }

  app.quit()
})

// Prevent Electron from quitting when the tailorEngine windows close.
app.on('window-all-closed', () => {})
