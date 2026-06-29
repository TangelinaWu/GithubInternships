const { app, BrowserWindow, Menu, session, webContents } = require('electron')
const path = require('path')
const fs   = require('fs')
const sheetsServer = require('./sheets-server')

const TAB_ID = 'ghinternships'

let mainWindow
let extensionId

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
        { label: 'Claude',                      accelerator: 'CmdOrCtrl+4', click: navigate('https://claude.ai/new') },
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

  // Tab 4 — Claude
  const claudeTab = makeTab('https://claude.ai/new')
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
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
