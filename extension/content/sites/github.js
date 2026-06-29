// GitHub README enhancer for internship listing repos.
// - Highlights rows as Applied / Skipped / New based on seen URLs from Sheets
// - Shows a summary badge in the top-right corner

const REPOS = [
  'zapplyjobs/Internships-2027',
  'sndsh404/summer-2027-internships',
  'SimplifyJobs/Summer2026-Internships',
]

const SOURCE_LABEL = (() => {
  const p = location.pathname.replace(/^\//, '')
  for (const r of REPOS) {
    if (p.toLowerCase().startsWith(r.toLowerCase())) return r.split('/')[1]
  }
  return 'GitHub'
})()

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Seen URL cache ────────────────────────────────────────────────────────────

let _seenUrls = new Set()

async function loadSeenUrls() {
  // From local extension storage (synced from Sheets on background startup)
  const result = await chrome.storage.local.get('seenJobUrls')
  const arr = result.seenJobUrls || []
  _seenUrls = new Set(arr)
  return _seenUrls
}

// ── Table row parsing ─────────────────────────────────────────────────────────

function getApplyUrl(td) {
  // Find the first non-locked apply link in a table cell.
  // Locked roles have 🔒 next to or instead of the link text.
  const anchors = Array.from(td.querySelectorAll('a[href]'))
  for (const a of anchors) {
    const text = a.textContent.trim()
    const href = a.href
    // Skip Simplify badge images or non-apply links
    if (!href || /github\.com\/(zapplyjobs|sndsh404|SimplifyJobs)/i.test(href)) continue
    if (/\.(png|jpg|svg|gif)$/i.test(href)) continue
    return href
  }
  return null
}

function isLocked(row) {
  return row.textContent.includes('🔒')
}

function extractRowInfo(row) {
  const cells = Array.from(row.querySelectorAll('td'))
  if (cells.length < 3) return null

  // Common table format: Company | Role | Location | (Date) | Apply
  const company  = cells[0]?.textContent.replace(/\s+/g, ' ').trim() || ''
  const role     = cells[1]?.textContent.replace(/\s+/g, ' ').trim() || ''
  const location = cells[2]?.textContent.replace(/\s+/g, ' ').trim() || ''

  // Find the apply link — usually the last column or any column with a link
  let applyUrl = null
  for (let i = cells.length - 1; i >= 0; i--) {
    applyUrl = getApplyUrl(cells[i])
    if (applyUrl) break
  }

  if (!company && !applyUrl) return null

  return { company, role, location, applyUrl, locked: isLocked(row) }
}

// ── Row highlighting ──────────────────────────────────────────────────────────

const STYLE_ID = 'gh-internships-styles'

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    tr.ghi-applied { background: rgba(34,197,94,.10) !important; }
    tr.ghi-applied td { color: #4ade80 !important; }
    tr.ghi-applied td a { color: #4ade80 !important; opacity: .7; }

    tr.ghi-skipped { background: rgba(100,116,139,.08) !important; }
    tr.ghi-skipped td { color: #475569 !important; opacity: .7; }

    tr.ghi-locked { opacity: .4; }

    .ghi-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 3px;
      margin-left: 6px;
      vertical-align: middle;
      font-family: -apple-system, sans-serif;
      line-height: 1.6;
    }
    .ghi-badge.applied { background: rgba(34,197,94,.15); color: #4ade80; border: 1px solid rgba(34,197,94,.3); }
    .ghi-badge.skipped { background: rgba(100,116,139,.12); color: #64748b; border: 1px solid rgba(100,116,139,.2); }
    .ghi-badge.new     { background: rgba(99,102,241,.15); color: #818cf8; border: 1px solid rgba(99,102,241,.3); }

    #ghi-summary {
      position: fixed;
      top: 70px;
      right: 20px;
      background: #0f172a;
      color: #f1f5f9;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 10px 14px;
      font-family: -apple-system, sans-serif;
      font-size: 12px;
      z-index: 9999;
      min-width: 160px;
      box-shadow: 0 4px 20px rgba(0,0,0,.5);
      line-height: 1.6;
    }
    #ghi-summary strong { font-size: 13px; display: block; margin-bottom: 4px; color: #818cf8; }
    #ghi-summary .s-row { display: flex; justify-content: space-between; gap: 14px; }
    #ghi-summary .s-val { font-weight: 700; }
    #ghi-summary .s-val.green { color: #4ade80; }
    #ghi-summary .s-val.grey  { color: #64748b; }
    #ghi-summary .s-val.indigo { color: #818cf8; }
  `
  document.head.appendChild(style)
}

let _summaryEl = null
function updateSummary(total, applied, skipped, locked) {
  if (!_summaryEl) {
    _summaryEl = document.createElement('div')
    _summaryEl.id = 'ghi-summary'
    document.body.appendChild(_summaryEl)
  }
  const newCount = total - applied - skipped - locked
  _summaryEl.innerHTML = `
    <strong>${SOURCE_LABEL}</strong>
    <div class="s-row"><span>Total</span><span class="s-val indigo">${total}</span></div>
    <div class="s-row"><span>Applied</span><span class="s-val green">${applied}</span></div>
    <div class="s-row"><span>Skipped</span><span class="s-val grey">${skipped}</span></div>
    <div class="s-row"><span>Locked 🔒</span><span class="s-val grey">${locked}</span></div>
    <div class="s-row"><span>New</span><span class="s-val indigo">${newCount < 0 ? 0 : newCount}</span></div>
  `
}

function highlightRows() {
  const rows = Array.from(document.querySelectorAll('article table tr, .markdown-body table tr'))
  let total = 0, applied = 0, skipped = 0, locked = 0

  for (const row of rows) {
    if (!row.querySelector('td')) continue
    const info = extractRowInfo(row)
    if (!info) continue

    total++

    if (info.locked) {
      row.classList.add('ghi-locked')
      locked++
      continue
    }

    if (info.applyUrl && _seenUrls.has(info.applyUrl)) {
      row.classList.add('ghi-applied')
      if (!row.querySelector('.ghi-badge')) {
        const badge = document.createElement('span')
        badge.className = 'ghi-badge applied'
        badge.textContent = '✓ applied'
        row.querySelector('td')?.appendChild(badge)
      }
      applied++
    } else {
      // Mark as new
      if (!row.querySelector('.ghi-badge.new') && !row.querySelector('.ghi-badge.applied')) {
        const badge = document.createElement('span')
        badge.className = 'ghi-badge new'
        badge.textContent = 'new'
        row.querySelector('td')?.appendChild(badge)
      }
    }
  }

  updateSummary(total, applied, skipped, locked)
}

// ── Storage listener — update highlights if a new URL is marked seen ──────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.seenJobUrls) return
  _seenUrls = new Set(changes.seenJobUrls.newValue || [])
  highlightRows()
})

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Only run on the target repos
  const path = location.pathname
  const isTargetRepo = REPOS.some(r => path.toLowerCase().startsWith('/' + r.toLowerCase()))
  if (!isTargetRepo) return

  injectStyles()
  await loadSeenUrls()
  highlightRows()

  // GitHub renders README asynchronously; re-highlight after a short delay
  setTimeout(highlightRows, 2000)

  // Also re-highlight when navigating (GitHub is a SPA)
  const observer = new MutationObserver(() => {
    requestAnimationFrame(highlightRows)
  })
  const article = document.querySelector('article') || document.querySelector('.markdown-body')
  if (article) observer.observe(article, { childList: true, subtree: true })
}

init()
