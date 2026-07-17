'use strict'
// npm run scan
// Reads "Github Internships" sheet for rows where Resume is filled and Applied
// is empty, then opens each job URL in an Electron window (with the extension
// loaded). The extension auto-fills the form; the user reviews and clicks
// "Confirm Applied". On confirmation, sheets-server marks Applied=Yes (col K)
// and this script opens the next job.
//
// Run: npm run scan
// Do NOT run simultaneously with npm start.

const { app, BrowserWindow, Menu, session, webContents } = require('electron')
const path   = require('path')
const fs     = require('fs')

const sheetsServer = require('../sheets-server')

const ROOT       = path.join(__dirname, '..')
const RESUMES_DIR = path.join(ROOT, 'resume')
const TAB_ID     = 'scan'

let extensionId   = null
let _bgWc         = null  // background page WebContents

// ── Extension loading (mirrors electron-main.js) ──────────────────────────────

async function loadExtension() {
  const ext = await session.defaultSession.extensions.loadExtension(
    path.join(ROOT, 'extension'),
    { allowFileAccess: true }
  )
  extensionId = ext.id
}

function patchUserAgent() {
  const ua = session.defaultSession.getUserAgent().replace(/ Electron\/[\d.]+/, '')
  session.defaultSession.setUserAgent(ua)
}

async function findBgWc() {
  const prefix = `chrome-extension://${extensionId}/`
  for (let i = 0; i < 30; i++) {
    const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith(prefix))
    if (wc) return wc
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}

function flattenProfile(creds) {
  const isFlat = creds.firstName !== undefined || creds.email !== undefined
  if (isFlat) return { ...creds }
  const flat = {}
  Object.assign(flat, creds.personal || {})
  Object.assign(flat, creds.work || {})
  flat.highestDegree      = creds.education?.highestDegree     || ''
  flat.fieldOfStudy       = creds.education?.fieldOfStudy      || ''
  flat.university         = creds.education?.university        || ''
  flat.graduationYear     = creds.education?.graduationYear    || ''
  flat.graduationMonth    = creds.education?.graduationMonth   || 'May'
  flat.gpa                = creds.education?.gpa               || ''
  flat.relevantCoursework = (creds.education?.relevantCoursework || []).join(', ')
  flat.skills             = (creds.skills         || []).join(', ')
  flat.certifications     = (creds.certifications || []).join(', ')
  flat.targetRoles        = (creds.targeting?.targetRoles         || []).join(', ')
  flat.preferredIndustries = (creds.targeting?.preferredIndustries || []).join(', ')
  flat.workExperience = (creds.workExperience || []).map(e =>
    `${e.company} · ${e.title} · ${e.startDate} – ${e.endDate}\n` +
    (e.bullets || []).map(b => `• ${b}`).join('\n')
  ).join('\n\n')
  flat.projects = (creds.projects || []).map(p =>
    `${p.name} — ${(p.technologies || []).join(', ')}\n` +
    (p.bullets || []).map(b => `• ${b}`).join('\n')
  ).join('\n\n')
  flat.professionalSummary = creds.narrative?.professionalSummary || ''
  flat.coverLetterTemplate = creds.narrative?.coverLetterTemplate  || ''
  Object.assign(flat, creds.demographics || {})
  return flat
}

async function seedCredentials() {
  const credPath = path.join(ROOT, 'credentials', 'profile.json')
  if (!fs.existsSync(credPath) || !_bgWc) return

  let creds
  try { creds = JSON.parse(fs.readFileSync(credPath, 'utf8')) }
  catch { return }

  const flat = flattenProfile(creds)

  const resumePath = path.join(ROOT, 'credentials', 'resume.pdf')
  if (fs.existsSync(resumePath)) {
    flat.resumeFileName = 'resume.pdf'
    flat.resumeDataUrl  = `data:application/pdf;base64,${fs.readFileSync(resumePath).toString('base64')}`
  }

  await _bgWc.executeJavaScript(`
    (async () => {
      let existing = {};
      try { const s = await chrome.storage.local.get('profile'); existing = s.profile || {}; } catch {}
      const merged = Object.assign({}, ${JSON.stringify(flat)}, {
        claudeApiKey:     existing.claudeApiKey     || '',
        linkedinEmail:    existing.linkedinEmail    || '',
        linkedinPassword: existing.linkedinPassword || '',
      });
      await chrome.storage.local.set({ profile: merged });
    })()
  `)

  const answersPath = path.join(ROOT, 'credentials', 'answers.json')
  if (fs.existsSync(answersPath)) {
    try {
      const { entries } = JSON.parse(fs.readFileSync(answersPath, 'utf8'))
      await _bgWc.executeJavaScript(`chrome.storage.local.set({ answers: ${JSON.stringify(entries || [])} })`)
    } catch {}
  }

  console.log('[scan] Credentials seeded')
}

// Swap the tailored PDF for this job into the extension's active profile so
// the form-filler uploads the right resume. Also sets the skip-tailor flag so
// ats-assessor.js won't spend 1-2 minutes re-tailoring.
async function preloadResume(job) {
  if (!_bgWc || !job.resumeFile) return
  const pdfPath = path.join(RESUMES_DIR, job.resumeFile)
  if (!fs.existsSync(pdfPath)) {
    console.warn(`[scan] Resume file not found: ${pdfPath}`)
    return
  }
  const pdfBase64 = fs.readFileSync(pdfPath).toString('base64')
  await _bgWc.executeJavaScript(`
    (async () => {
      const stored = await chrome.storage.local.get('profile')
      const profile = stored.profile || {}
      await chrome.storage.local.set({
        skipResumeForUrl: ${JSON.stringify(job.url)},
        profile: {
          ...profile,
          resumeFileName: ${JSON.stringify(job.resumeFile)},
          resumeDataUrl:  'data:application/pdf;base64,${pdfBase64}',
        },
      })
    })()
  `)
  console.log(`[scan] Pre-loaded resume: ${job.resumeFile}`)
}

// ── Job queue ─────────────────────────────────────────────────────────────────

// Resolves with the log entry when the extension reports a decision for `url`.
function waitForJobCompletion(url, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve) => {
    let resolved = false
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ url, decision: 'TIMEOUT' }) }
    }, timeoutMs)

    sheetsServer.setOnLogCallback((entry) => {
      if (!resolved && entry.url === url) {
        resolved = true
        clearTimeout(timer)
        resolve(entry)
      }
    })
  })
}

async function openJobWindow(url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    tabbingIdentifier: TAB_ID,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  win.loadURL(url)
  return win
}

async function runQueue(queue) {
  console.log(`[scan] Processing ${queue.length} job(s)`)

  for (const job of queue) {
    console.log(`\n[scan] ── ${job.company} — ${job.role}`)
    console.log(`[scan]    URL: ${job.url}`)
    console.log(`[scan]    Resume: ${job.resumeFile}`)

    await preloadResume(job)

    const completionPromise = waitForJobCompletion(job.url)
    const win = await openJobWindow(job.url)

    const entry = await completionPromise
    console.log(`[scan] Decision: ${entry.decision} — ${job.company}`)

    if (!win.isDestroyed()) {
      await new Promise(r => setTimeout(r, 1500))
      win.close()
    }

    // Small pause before opening the next job
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log('\n[scan] All jobs processed')
}

// ── App entry point ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  patchUserAgent()
  await loadExtension()

  sheetsServer.loadConfig()
  sheetsServer.startServer()

  // Register physical-click handler
  sheetsServer.setPhysicalClickHandler(async (url) => {
    const win = BrowserWindow.getAllWindows().find(w => {
      if (w.isDestroyed()) return false
      const wUrl = w.webContents.getURL()
      return wUrl === url || wUrl.split('?')[0] === url.split('?')[0]
    })
    if (!win) return { clicked: false, reason: 'window-not-found' }

    const startUrl = win.webContents.getURL()
    const rects = await win.webContents.executeJavaScript(`
      (() => {
        const btns = [...document.querySelectorAll('a[href], button, [role="button"]')]
          .filter(el => {
            const t = (el.innerText || '').trim()
            return /(apply|submit application)/i.test(t) && t.length < 40
          })
        return btns.map(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })
      })()
    `).catch(() => [])

    for (const rect of rects) {
      win.show(); win.focus()
      win.webContents.sendInputEvent({ type: 'mouseMove',  x: rect.x, y: rect.y })
      await new Promise(r => setTimeout(r, 80))
      win.webContents.sendInputEvent({ type: 'mouseDown',  x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
      await new Promise(r => setTimeout(r, 60))
      win.webContents.sendInputEvent({ type: 'mouseUp',    x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
      await new Promise(r => setTimeout(r, 1200))
      if (win.webContents.getURL() !== startUrl || await win.webContents.executeJavaScript(`!!document.querySelector('form input')`).catch(() => false)) {
        return { clicked: true, x: rect.x, y: rect.y }
      }
    }
    return { clicked: false, reason: 'no-form-after-click' }
  })

  sheetsServer.setSaveAnswersHandler(async (entries) => {
    const p = path.join(ROOT, 'credentials', 'answers.json')
    fs.writeFileSync(p, JSON.stringify({ entries }, null, 2))
    return { ok: true, saved: entries.length }
  })

  // Give the extension background page a moment to initialise
  await new Promise(r => setTimeout(r, 800))
  _bgWc = await findBgWc()
  await seedCredentials()

  // Read the scan queue from Sheets
  const queue = await sheetsServer.getScanQueue()

  if (queue.length === 0) {
    console.log('[scan] No jobs with Resume filled and Applied empty — nothing to do')
    app.quit()
    return
  }

  console.log(`[scan] Queue: ${queue.length} job(s) to apply to`)
  queue.forEach((j, i) => console.log(`  ${i + 1}. ${j.company} — ${j.role}`))

  await runQueue(queue)
  app.quit()
})

app.on('window-all-closed', () => {})
