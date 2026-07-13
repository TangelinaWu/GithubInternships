const { app, BrowserWindow, Menu, session, webContents } = require('electron')
const path = require('path')
const fs   = require('fs')
const sheetsServer = require('./sheets-server')

const TAB_ID = 'ghinternships'

// Must stay in sync with CLAUDE_PROJECT_URL in extension/background/background.js
// and extension/content/sites/claude.js
const CLAUDE_PROJECT_URL = 'https://claude.ai/project/019ead72-f6d6-74aa-84ee-5c652fd866d0'

let mainWindow
let extensionId
let initialWindowsCreated = false  // true once startup tabs are created

// ── Physical-click helpers ────────────────────────────────────────────────────

// Candidate-finding logic must stay in sync with content/main.js
// clickIntermediateApplyIfNeeded (same per-site selectors + fuzzy text match).
const SITE_APPLY_SELECTORS_SRC = JSON.stringify({
  'greenhouse.io':     ['#apply_button', 'a[href="#app"]', '.postings-btn', 'button[id*="apply" i]'],
  'lever.co':          ['.postings-btn', 'a.postings-btn', '.template-btn-submit'],
  'myworkdayjobs.com': ['[data-automation-id="applyButton"]', '[data-automation-id="adventureButton"]', 'button[data-automation-id*="apply" i]'],
  'ashbyhq.com':       ['a[href*="/application"]', 'button[class*="apply" i]', '[data-testid*="apply" i]'],
  'joinhandshake.com': ['button[class*="apply" i]', '[data-hook*="apply" i]'],
  'simplify.jobs':     ['button[class*="apply" i]', 'a[class*="apply" i]', 'button[class*="easy" i]'],
})

const FORM_SEL = 'form input:not([type="hidden"]), form select, form textarea'

// Find the BrowserWindow whose URL matches (exact or same-path prefix)
function findWindowByUrl(url) {
  const targetPath = url.split('?')[0].replace(/#.*$/, '')
  return BrowserWindow.getAllWindows().find(w => {
    if (w.isDestroyed()) return false
    const wUrl = w.webContents.getURL()
    return wUrl === url || wUrl.split('?')[0].replace(/#.*$/, '') === targetPath
  })
}

// Ask the page for the center point of every visible Apply-looking candidate,
// most-reliable (site-specific selector) matches first.
async function findApplyCandidateRects(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const siteSelectors = ${SITE_APPLY_SELECTORS_SRC}
      const isVisible = (el) => {
        const s = getComputedStyle(el)
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const looksLikeApplyText = (text) => {
        if (!text || text.length > 40) return false
        return /(easy\\s+apply|quick\\s+apply|apply\\s*(now|here)?|apply\\s+(for|to)\\s+(this\\s+)?(job|position|role|opening|internship)|submit\\s+(your\\s+)?application|i.?m\\s+interested)/i.test(text)
      }
      const host  = location.hostname.toLowerCase()
      const entry = Object.entries(siteSelectors).find(([d]) => host.includes(d))
      const selectors = entry ? entry[1] : []
      const seen = new Set()
      const out  = []
      const add  = (el) => { if (el && !seen.has(el) && isVisible(el)) { seen.add(el); out.push(el) } }
      selectors.forEach(sel => document.querySelectorAll(sel).forEach(add))
      document.querySelectorAll('a[href], button, [role="button"]').forEach(el => {
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
        if (looksLikeApplyText(text)) add(el)
      })
      return out.map(el => {
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })
    })()
  `).catch(() => [])
}

async function pageHasForm(win) {
  return win.webContents.executeJavaScript(`!!document.querySelector('${FORM_SEL}')`).catch(() => false)
}

// Perform an OS-level mouse click on the Apply button inside `win`, verifying
// it actually did something (form appeared or the page navigated) before
// declaring success — a click that hits a decorative element and does nothing
// must be reported as a failure so the caller falls back to the JS-based method.
// Returns { clicked: true } or { clicked: false, reason: '...' }.
async function physicalClickApply(win) {
  if (!win || win.isDestroyed()) return { clicked: false, reason: 'window-gone' }
  if (await pageHasForm(win)) return { clicked: false, reason: 'form-already-present' }

  const startUrl = win.webContents.getURL()

  for (let round = 0; round < 3; round++) {
    if (round > 0) await new Promise(r => setTimeout(r, 1200))
    if (win.isDestroyed()) return { clicked: false, reason: 'window-gone' }

    const rects = await findApplyCandidateRects(win)
    if (!rects.length) continue

    for (const rect of rects) {
      if (win.isDestroyed()) return { clicked: false, reason: 'window-gone' }

      // Bring the window to front so the user can watch
      win.show()
      win.focus()
      await new Promise(r => setTimeout(r, 150))

      // OS-level input events — same pipeline as real mouse, reliable on React SPAs
      win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
      await new Promise(r => setTimeout(r, 80))
      win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
      await new Promise(r => setTimeout(r, 60))
      win.webContents.sendInputEvent({ type: 'mouseUp',   x: rect.x, y: rect.y, button: 'left', clickCount: 1 })

      await new Promise(r => setTimeout(r, 1200))
      if (win.isDestroyed()) return { clicked: false, reason: 'window-gone' }

      if (win.webContents.getURL() !== startUrl) {
        console.log(`[GHI] ✓ Physical click navigated (${rect.x}, ${rect.y}) — ${win.webContents.getURL()}`)
        return { clicked: true, x: rect.x, y: rect.y }
      }
      if (await pageHasForm(win)) {
        console.log(`[GHI] ✓ Physical click revealed form (${rect.x}, ${rect.y}) — ${win.webContents.getURL()}`)
        return { clicked: true, x: rect.x, y: rect.y }
      }
    }
  }

  return { clicked: false, reason: 'no-form-after-click' }
}

// ─────────────────────────────────────────────────────────────────────────────

async function loadExtension() {
  const ext = await session.defaultSession.extensions.loadExtension(
    path.join(__dirname, 'extension'),
    { allowFileAccess: true }
  )
  extensionId = ext.id
}

function patchUserAgent() {
  const ua = session.defaultSession.getUserAgent().replace(/ Electron\/[\d.]+/, '')
  session.defaultSession.setUserAgent(ua)
}

function attachContextMenu(win) {
  win.webContents.on('context-menu', (_e, params) => {
    const template = []
    if (params.isEditable) {
      template.push(
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      )
    } else if (params.selectionText.trim()) {
      template.push({ role: 'copy' })
    }
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: win })
  })
}

function makeTab(url) {
  const win = new BrowserWindow({
    tabbingIdentifier: TAB_ID,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  win.loadURL(url)
  attachContextMenu(win)
  return win
}

function openSettings() {
  if (!extensionId) return
  const win = new BrowserWindow({
    width: 860,
    height: 920,
    title: 'GH Internships — Settings',
    autoHideMenuBar: true,
  })
  win.loadURL(`chrome-extension://${extensionId}/options/options.html`)
  attachContextMenu(win)
}

function buildMenu() {
  const navigate = (url) => () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow
    if (win) win.loadURL(url)
  }

  const template = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'GH Internships',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { label: 'Reload Credentials', click: () => seedCredentialsToStorage() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Go To',
      submenu: [
        { label: 'Internships 2027 (zapply)',   accelerator: 'CmdOrCtrl+1', click: navigate('https://github.com/zapplyjobs/Internships-2027') },
        { label: 'Summer 2027 (sndsh404)',      accelerator: 'CmdOrCtrl+2', click: navigate('https://github.com/sndsh404/summer-2027-internships') },
        { label: 'Summer 2026 (Simplify)',      accelerator: 'CmdOrCtrl+3', click: navigate('https://github.com/SimplifyJobs/Summer2026-Internships') },
        { label: 'Claude',                      accelerator: 'CmdOrCtrl+4', click: navigate(CLAUDE_PROJECT_URL) },
        { label: 'Google Sheets',               accelerator: 'CmdOrCtrl+5', click: navigate('https://sheets.google.com') },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back',    accelerator: 'Cmd+[', click() { const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.goBack() } },
        { label: 'Forward', accelerator: 'Cmd+]', click() { const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.goForward() } },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}

function flattenCredentials(creds) {
  const isFlat = creds.firstName !== undefined || creds.email !== undefined ||
                 creds.lastName !== undefined  || creds.phone !== undefined
  if (isFlat) return { ...creds }

  const flat = {}
  Object.assign(flat, creds.personal  || {})
  Object.assign(flat, creds.work      || {})
  flat.highestDegree       = creds.education?.highestDegree      || ''
  flat.fieldOfStudy        = creds.education?.fieldOfStudy       || ''
  flat.university          = creds.education?.university         || ''
  flat.graduationYear      = creds.education?.graduationYear     || ''
  flat.graduationMonth     = creds.education?.graduationMonth    || 'May'
  flat.gpa                 = creds.education?.gpa                || ''
  flat.relevantCoursework  = (creds.education?.relevantCoursework || []).join(', ')
  flat.skills              = (creds.skills        || []).join(', ')
  flat.certifications      = (creds.certifications || []).join(', ')
  flat.targetRoles         = (creds.targeting?.targetRoles          || []).join(', ')
  flat.preferredIndustries = (creds.targeting?.preferredIndustries  || []).join(', ')
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

async function seedCredentialsToStorage() {
  const credPath = path.join(__dirname, 'credentials', 'profile.json')
  if (!fs.existsSync(credPath)) return

  let creds
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf8'))
  } catch (e) {
    console.warn('[GHInternships] credentials/profile.json parse error:', e.message)
    return
  }

  const flat = flattenCredentials(creds)

  const resumePath = path.join(__dirname, 'credentials', 'resume.pdf')
  if (fs.existsSync(resumePath)) {
    const pdfBase64 = fs.readFileSync(resumePath).toString('base64')
    flat.resumeFileName = 'resume.pdf'
    flat.resumeDataUrl  = `data:application/pdf;base64,${pdfBase64}`
  }

  const bgPrefix = `chrome-extension://${extensionId}/`
  let bgWc = null
  for (let i = 0; i < 20 && !bgWc; i++) {
    bgWc = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(bgPrefix))
    if (!bgWc) await new Promise(r => setTimeout(r, 100))
  }
  if (!bgWc) {
    console.warn('[GHInternships] Background page not found — credentials not seeded')
    return
  }

  await bgWc.executeJavaScript(`
    (async () => {
      let existing = {};
      try {
        const stored = await chrome.storage.local.get('profile');
        existing = (stored && stored.profile) || {};
      } catch (e) {}
      const fromFile = ${JSON.stringify(flat)};
      const merged = Object.assign({}, fromFile, {
        claudeApiKey:     existing.claudeApiKey     || '',
        linkedinEmail:    existing.linkedinEmail    || fromFile.linkedinEmail || '',
        linkedinPassword: existing.linkedinPassword || '',
      });
      await chrome.storage.local.set({ profile: merged });
    })()
  `)
  console.log('[GHInternships] Credentials seeded')

  const answersPath = path.join(__dirname, 'credentials', 'answers.json')
  if (fs.existsSync(answersPath)) {
    try {
      const { entries } = JSON.parse(fs.readFileSync(answersPath, 'utf8'))
      await bgWc.executeJavaScript(`chrome.storage.local.set({ answers: ${JSON.stringify(entries || [])} })`)
    } catch (e) {
      console.warn('[GHInternships] credentials/answers.json parse error:', e.message)
    }
  }
}

async function createWindow() {
  patchUserAgent()
  await loadExtension()
  sheetsServer.startServer()

  // Register physical-click handler so ats-assessor.js can request native clicks
  sheetsServer.setPhysicalClickHandler(async (url) => {
    const win = findWindowByUrl(url)
    if (!win) return { clicked: false, reason: 'window-not-found' }
    return physicalClickApply(win)
  })

  // Register save-answers handler — persists Q&A entries scanned from a
  // manually-filled form back to credentials/answers.json, so they survive
  // across restarts (chrome.storage alone would be wiped on reinstall).
  sheetsServer.setSaveAnswersHandler(async (entries) => {
    const answersPath = path.join(__dirname, 'credentials', 'answers.json')
    fs.writeFileSync(answersPath, JSON.stringify({ entries }, null, 2))
    console.log(`[GHInternships] Saved ${entries.length} answer entries to credentials/answers.json`)
    return { ok: true, saved: entries.length }
  })

  seedCredentialsToStorage()

  // Tab 1 — Internships 2027 (zapply)
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    tabbingIdentifier: TAB_ID,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  mainWindow.loadURL('https://github.com/zapplyjobs/Internships-2027')
  mainWindow.on('closed', () => { mainWindow = null })
  attachContextMenu(mainWindow)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
  mainWindow.webContents.on('did-create-window', win => {
    attachContextMenu(win)
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
    win.webContents.on('did-create-window', w2 => attachContextMenu(w2))
  })

  Menu.setApplicationMenu(buildMenu())

  // Tab 2 — summer-2027-internships
  const tab2 = makeTab('https://github.com/sndsh404/summer-2027-internships')
  mainWindow.addTabbedWindow(tab2)

  // Tab 3 — Summer2026-Internships
  const tab3 = makeTab('https://github.com/SimplifyJobs/Summer2026-Internships')
  mainWindow.addTabbedWindow(tab3)

  // Tab 4 — Claude (the "Job Applier" project, not a generic new chat)
  const claudeTab = makeTab(CLAUDE_PROJECT_URL)
  mainWindow.addTabbedWindow(claudeTab)

  // Control panel — always on top, match assessor
  const controlWindow = new BrowserWindow({
    width: 380,
    height: 480,
    title: 'GH Internships — Assessor',
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  controlWindow.loadURL(`chrome-extension://${extensionId}/control/control.html`)
  attachContextMenu(controlWindow)

  mainWindow.focus()

  // From this point on, any new BrowserWindow was opened by the extension
  // (e.g. via chrome.tabs.create) — bring it to front so progress is visible
  initialWindowsCreated = true
}

// Bring every dynamically-created apply tab to the front so the user can see
// the automation working.  Runs for ALL windows opened after startup — except
// the resume-tailoring engine's own hidden windows (JobApplier's shared
// resume_tailor/tailorEngine.js opens a claude.ai/new chat and a temp-file
// HTML→PDF render window, both with show:false), which must stay in the
// background or tailoring visibly "pops up" mid-apply and steals focus.
function isHiddenTailoringWindow(win) {
  const url = win.webContents.getURL()
  return url.startsWith('https://claude.ai/new') || url.includes('tailored_resume_render_')
}

app.on('browser-window-created', (_event, win) => {
  if (!initialWindowsCreated) return  // skip startup windows
  attachContextMenu(win)
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
  win.webContents.on('did-create-window', w2 => attachContextMenu(w2))
  // Show immediately — dom-ready fires too late to feel snappy
  win.once('ready-to-show', () => {
    if (win.isDestroyed() || isHiddenTailoringWindow(win)) return
    win.show()
    win.focus()
  })
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
