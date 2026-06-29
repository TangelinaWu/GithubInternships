// GH Internships — Control Panel (Assessor)
// Shows Claude fit-check results for ATS pages opened from GitHub repos.
// User clicks Apply → logs to Sheets + starts form fill.
// User clicks Skip  → logs to Sheets as skipped.

let _currentJob = null   // payload from the most recent FIT_RESULT message
let pendingRequestId = null

// ── Tab switching ─────────────────────────────────────────────────────────────

const tabAssess = document.getElementById('tab-assess')
const tabAi     = document.getElementById('tab-ai')
const tabLog    = document.getElementById('tab-log')
const paneAssess = document.getElementById('pane-assess')
const paneAi     = document.getElementById('pane-ai')
const paneLog    = document.getElementById('pane-log')
const aiBadge    = document.getElementById('ai-badge')
const assessBadge = document.getElementById('assess-badge')

tabAssess.addEventListener('click', () => switchTab('assess'))
tabAi.addEventListener('click',     () => { switchTab('ai'); aiBadge.classList.add('hidden') })
tabLog.addEventListener('click',    () => switchTab('log'))

function switchTab(which) {
  tabAssess.classList.toggle('tab-active', which === 'assess')
  tabAi.classList.toggle('tab-active',     which === 'ai')
  tabLog.classList.toggle('tab-active',    which === 'log')
  paneAssess.classList.toggle('hidden', which !== 'assess')
  paneAi.classList.toggle('hidden',     which !== 'ai')
  paneLog.classList.toggle('hidden',    which !== 'log')
}

// ── Assess pane states ────────────────────────────────────────────────────────

const idleState    = document.getElementById('idle-state')
const loadingState = document.getElementById('loading-state')
const resultState  = document.getElementById('result-state')

function showIdle() {
  idleState.classList.remove('hidden')
  loadingState.classList.add('hidden')
  resultState.classList.add('hidden')
  assessBadge.classList.add('hidden')
  _currentJob = null
}

function showLoading(company, role) {
  idleState.classList.add('hidden')
  loadingState.classList.remove('hidden')
  resultState.classList.add('hidden')
  document.getElementById('loading-company').textContent = company || 'Loading…'
  document.getElementById('loading-role').textContent    = role    || ''
  switchTab('assess')
}

function showResult(payload) {
  idleState.classList.add('hidden')
  loadingState.classList.add('hidden')
  resultState.classList.remove('hidden')

  const { score, scoreLabel, company, title, matching, missing, recommendation, alreadySeen } = payload

  // Score circle colour
  const circle = document.getElementById('result-score-circle')
  circle.className = 'score-circle ' + scoreClass(score)
  document.getElementById('result-score-num').textContent = score != null ? score : '?'

  document.getElementById('result-company').textContent = company || ''
  document.getElementById('result-role').textContent    = title   || ''
  document.getElementById('result-label').textContent   = scoreLabel || ''
  document.getElementById('result-label').className     = 'score-label ' + scoreClass(score)

  document.getElementById('result-recommendation').textContent = recommendation || ''

  const matchUl = document.getElementById('list-matching')
  const missUl  = document.getElementById('list-missing')
  matchUl.innerHTML = (matching || []).map(s => `<li>${esc(s)}</li>`).join('') || '<li class="empty">—</li>'
  missUl.innerHTML  = (missing  || []).map(s => `<li>${esc(s)}</li>`).join('') || '<li class="empty">—</li>'

  const alreadyBanner = document.getElementById('already-seen-banner')
  const actionBtns    = document.getElementById('result-actions')

  if (alreadySeen) {
    alreadyBanner.classList.remove('hidden')
    actionBtns.classList.add('hidden')
  } else {
    alreadyBanner.classList.add('hidden')
    actionBtns.classList.remove('hidden')
  }

  // Flash badge
  assessBadge.textContent = score != null ? score : '?'
  assessBadge.classList.remove('hidden')
  switchTab('assess')

  // Desktop notification (macOS)
  const label = scoreLabel || (score >= 7 ? 'Good Match' : score >= 4 ? 'Fair Match' : 'Weak Match')
  const icon  = score >= 7 ? '✓' : score >= 4 ? '~' : '✗'
  chrome.notifications?.create({
    type:    'basic',
    iconUrl: '../assets/icons/icon-48.png',
    title:   `${icon} ${label} — ${company || 'Job'}`,
    message: recommendation || `Score: ${score}/10`,
  })
}

function scoreClass(score) {
  if (score == null) return 'neutral'
  if (score === 0)   return 'disqualified'
  if (score >= 7)    return 'good'
  if (score >= 4)    return 'fair'
  return 'weak'
}

// ── Apply / Skip buttons ──────────────────────────────────────────────────────

document.getElementById('btn-apply').addEventListener('click', () => {
  if (!_currentJob) return
  chrome.runtime.sendMessage({ type: MSG.GH_DO_APPLY, payload: _currentJob })
  addLog(`Applied — ${_currentJob.company} · ${_currentJob.title || ''}`, 'success')
  showIdle()
})

document.getElementById('btn-skip').addEventListener('click', () => {
  if (!_currentJob) return
  const reason = 'User skipped'
  chrome.runtime.sendMessage({ type: MSG.GH_DO_SKIP, payload: { ..._currentJob, reason } })
  addLog(`Skipped — ${_currentJob.company} · ${_currentJob.title || ''}`, 'skip')
  showIdle()
})

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {

  // New ATS page detected — show loading or already-seen
  if (msg.type === MSG.GH_ASSESSING) {
    const { title, company, loading, alreadySeen } = msg.payload || {}
    if (alreadySeen) {
      _currentJob = msg.payload
      showResult({ ...msg.payload, score: null, scoreLabel: 'Already Seen', matching: [], missing: [], recommendation: 'You have already applied or skipped this job.' })
    } else if (loading) {
      showLoading(company, title)
    }
  }

  // Claude returned the fit result
  if (msg.type === MSG.FIT_RESULT) {
    _currentJob = msg.payload
    showResult(msg.payload)
    addLog(`Assessed: ${msg.payload.company} — ${msg.payload.scoreLabel || msg.payload.score + '/10'}`, 'claude')
  }

  // Auto-apply pipeline
  if (msg.type === MSG.AUTO_APPLY_STARTED) {
    addLog(`Applying — ${msg.payload?.company || 'company'}`, 'apply')
  }
  if (msg.type === MSG.AUTO_APPLY_FILLING) {
    addLog(`Filling form — ${msg.payload?.company || 'company'}`, 'fill')
  }
  if (msg.type === MSG.AUTO_APPLY_COMPLETE) {
    addLog(`Submitted — ${msg.payload?.company || 'company'} ✓`, 'success')
    showIdle()
  }

  // Fill log from form filler
  if (msg.type === MSG.FILL_LOG) {
    const { label, status } = msg.payload || {}
    if (status === 'filled')   addLog(`Filled: ${capitalize(label)}`, 'fill')
    if (status === 'uploaded') addLog('Resume uploaded', 'fill')
    if (status === 'unknown')  addLog(`? Unknown field: ${label}`, 'claude')
  }

  // Overlay Q&A (unknown form fields)
  if (msg.type === MSG.OVERLAY_QUESTION) {
    const { requestId, question, suggestion } = msg.payload || {}
    pendingRequestId = requestId
    document.getElementById('ai-question').textContent = question || ''
    const processed = 'suggestion' in (msg.payload || {})
    const aiLoading = document.getElementById('ai-loading')
    const aiAnswer  = document.getElementById('ai-answer')
    const aiUse     = document.getElementById('ai-use')
    if (processed) {
      aiLoading.classList.add('hidden')
      aiAnswer.classList.remove('hidden')
      aiAnswer.value = suggestion || ''
      aiUse.disabled = false
    } else {
      aiLoading.classList.remove('hidden')
      aiAnswer.classList.add('hidden')
      aiAnswer.value = ''
      aiUse.disabled = true
    }
    document.getElementById('ai-empty').classList.add('hidden')
    document.getElementById('ai-form').classList.remove('hidden')
    aiBadge.classList.remove('hidden')
    switchTab('ai')
  }
})

// ── AI panel actions ──────────────────────────────────────────────────────────

document.getElementById('ai-skip').addEventListener('click', () => {
  if (!pendingRequestId) return
  chrome.runtime.sendMessage({
    type: MSG.OVERLAY_ANSWER,
    payload: { requestId: pendingRequestId, accepted: false, value: null },
  })
  clearAiPanel()
  switchTab('assess')
})

document.getElementById('ai-use').addEventListener('click', () => {
  if (!pendingRequestId) return
  const val = document.getElementById('ai-answer').value
  chrome.runtime.sendMessage({
    type: MSG.OVERLAY_ANSWER,
    payload: { requestId: pendingRequestId, accepted: true, value: val },
  })
  clearAiPanel()
  switchTab('assess')
})

function clearAiPanel() {
  pendingRequestId = null
  document.getElementById('ai-form').classList.add('hidden')
  document.getElementById('ai-empty').classList.remove('hidden')
  document.getElementById('ai-answer').value = ''
  document.getElementById('ai-question').textContent = ''
}

// ── Activity log ──────────────────────────────────────────────────────────────

const logEl = document.getElementById('log')

function addLog(text, type = 'info') {
  const now   = new Date()
  const time  = now.toTimeString().slice(0, 8)
  const entry = document.createElement('div')
  entry.className = `log-entry ${type}`
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${esc(text)}</span>`
  logEl.appendChild(entry)
  logEl.scrollTop = logEl.scrollHeight
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild)
}

document.getElementById('btn-clear-log').addEventListener('click', () => {
  logEl.innerHTML = ''
})

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function capitalize(s) {
  return String(s || '').replace(/\b\w/g, c => c.toUpperCase())
}
