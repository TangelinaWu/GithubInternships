// GH Internships — Control Panel (Assessor)
// Shows Claude fit-check results for ATS pages opened from GitHub repos.
// User clicks Apply → logs to Sheets + starts form fill.
// User clicks Skip  → logs to Sheets as skipped.

let _currentJob = null   // payload from the most recent FIT_RESULT message
let pendingRequestId = null

// ── Source picker — "which page do you want to apply to?" ─────────────────

const sourcePicker = document.getElementById('source-picker')
const sourceList    = document.getElementById('source-list')
let _lastSources = []
let _queueActive  = false

function renderSources(sources) {
  if (sources) _lastSources = sources
  const pending = _lastSources.filter(s => s.pending > 0)

  if (_queueActive || pending.length === 0) {
    sourcePicker.classList.add('hidden')
    return
  }

  sourcePicker.classList.remove('hidden')
  sourceList.innerHTML = pending.map(s => `
    <button class="source-btn" data-tab-id="${s.tabId}" data-repo="${esc(s.repo)}">
      <span>${esc(s.repo)}</span>
      <span class="source-count">${s.pending}</span>
    </button>
  `).join('')

  sourceList.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = Number(btn.dataset.tabId)
      chrome.runtime.sendMessage({ type: MSG.PICK_SOURCE, payload: { tabId } })
      addLog(`Starting auto-apply — ${btn.dataset.repo}`, 'system')
    })
  })
}

chrome.runtime.sendMessage({ type: MSG.REQUEST_SOURCES }, (resp) => {
  renderSources(resp?.sources)
})

// ── Queue progress strip ──────────────────────────────────────────────────────

const queueStrip  = document.getElementById('queue-strip')
const queueFill   = document.getElementById('queue-strip-fill')
const queueCount  = document.getElementById('queue-strip-count')
const queueLabel  = document.getElementById('queue-strip-label')
const queuePauseBtn = document.getElementById('queue-strip-pause')
let   _queueDoneTimer = null
let   _queuePaused     = false

function setQueuePauseBtn(paused) {
  _queuePaused = paused
  queuePauseBtn.textContent = paused ? '▶' : '⏸'
  queuePauseBtn.title = paused
    ? 'Resume the queue'
    : 'Pause the queue so it stops opening new jobs'
  queuePauseBtn.classList.toggle('resume', paused)
}

queuePauseBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: _queuePaused ? MSG.QUEUE_RESUME : MSG.QUEUE_PAUSE })
})

function showQueueStrip(done, total) {
  if (_queueDoneTimer) { clearTimeout(_queueDoneTimer); _queueDoneTimer = null }
  queueStrip.classList.remove('hidden')
  queuePauseBtn.classList.remove('hidden')
  if (!_queuePaused) {
    queueLabel.textContent = '⏳ Queue'
    queueLabel.style.color = '#818cf8'
    queueFill.style.background = '#6366f1'
  }
  queueCount.textContent = `${done} / ${total}`
  queueFill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%'
}

function doneQueueStrip(done, total) {
  setQueuePauseBtn(false)
  queueStrip.classList.remove('hidden')
  queuePauseBtn.classList.add('hidden')
  queueLabel.textContent = '✓ Done'
  queueLabel.style.color = '#4ade80'
  queueCount.textContent = `${done} / ${total}`
  queueFill.style.background = '#22c55e'
  queueFill.style.width = '100%'
  _queueDoneTimer = setTimeout(() => queueStrip.classList.add('hidden'), 10000)
}

// ── Tab switching ─────────────────────────────────────────────────────────────

const tabAssess = document.getElementById('tab-assess')
const tabAi     = document.getElementById('tab-ai')
const tabReview = document.getElementById('tab-review')
const tabLog    = document.getElementById('tab-log')
const paneAssess = document.getElementById('pane-assess')
const paneAi     = document.getElementById('pane-ai')
const paneReview = document.getElementById('pane-review')
const paneLog    = document.getElementById('pane-log')
const aiBadge    = document.getElementById('ai-badge')
const assessBadge = document.getElementById('assess-badge')
const reviewBadge = document.getElementById('review-badge')

tabAssess.addEventListener('click', () => switchTab('assess'))
tabAi.addEventListener('click',     () => { switchTab('ai'); aiBadge.classList.add('hidden') })
tabReview.addEventListener('click', () => switchTab('review'))
tabLog.addEventListener('click',    () => switchTab('log'))

function switchTab(which) {
  tabAssess.classList.toggle('tab-active', which === 'assess')
  tabAi.classList.toggle('tab-active',     which === 'ai')
  tabReview.classList.toggle('tab-active', which === 'review')
  tabLog.classList.toggle('tab-active',    which === 'log')
  paneAssess.classList.toggle('hidden', which !== 'assess')
  paneAi.classList.toggle('hidden',     which !== 'ai')
  paneReview.classList.toggle('hidden', which !== 'review')
  paneLog.classList.toggle('hidden',    which !== 'log')
}

// ── Review pane — jobs skipped from the Failed state ───────────────────────
// These couldn't be auto-detected/auto-applied. Rather than logging them as
// Skipped immediately, they're parked here so the user can reopen the page
// and mark it Applied by hand later. Marked seen right away so they don't
// keep reopening from future auto-apply queue runs.

const reviewEmpty = document.getElementById('review-empty')
const reviewList  = document.getElementById('review-list')

function renderReview(list) {
  reviewBadge.textContent = list.length
  reviewBadge.classList.toggle('hidden', list.length === 0)
  reviewEmpty.classList.toggle('hidden', list.length > 0)

  reviewList.innerHTML = list.map(item => `
    <div class="review-item" data-url="${esc(item.url)}">
      <div class="review-item-company">${esc(item.company)}</div>
      <div class="review-item-role">${esc(item.title)}</div>
      <div class="review-item-reason">${esc(item.reason)}</div>
      <div class="review-item-actions">
        <button class="review-reopen">↗ Reopen</button>
        <button class="review-applied">✓ Applied</button>
        <button class="review-dismiss">✕ Dismiss</button>
      </div>
    </div>
  `).join('')
}

async function refreshReview() {
  renderReview(await getNeedsAttention())
}

reviewList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  const itemEl = btn.closest('.review-item')
  const url = itemEl?.dataset.url
  if (!url) return

  const list = await getNeedsAttention()
  const item = list.find(it => it.url === url)
  if (!item) return

  if (btn.classList.contains('review-reopen')) {
    window.open(url, '_blank', 'noopener')
    return
  }

  if (btn.classList.contains('review-applied')) {
    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site: 'github', company: item.company, role: item.title, url: item.url,
        sourceRepo: item.sourceRepo, decision: 'APPLIED',
        reason: 'Manually applied after review',
      },
    })
    addLog(`✓ Marked applied — ${item.company} · ${item.title || ''}`, 'success')
    await removeNeedsAttention(url)
    refreshReview()
    return
  }

  if (btn.classList.contains('review-dismiss')) {
    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site: 'github', company: item.company, role: item.title, url: item.url,
        sourceRepo: item.sourceRepo, decision: 'SKIPPED',
        reason: 'Skipped after review',
      },
    })
    addLog(`Skipped — ${item.company} · ${item.title || ''}`, 'skip')
    await removeNeedsAttention(url)
    refreshReview()
  }
})

refreshReview()

// ── Assess pane states ────────────────────────────────────────────────────────

const idleState    = document.getElementById('idle-state')
const loadingState = document.getElementById('loading-state')
const resultState  = document.getElementById('result-state')
const failedState  = document.getElementById('failed-state')

function showIdle() {
  idleState.classList.remove('hidden')
  loadingState.classList.add('hidden')
  resultState.classList.add('hidden')
  failedState.classList.add('hidden')
  assessBadge.classList.add('hidden')
  _currentJob = null
}

function showLoading(company, role) {
  idleState.classList.add('hidden')
  loadingState.classList.remove('hidden')
  resultState.classList.add('hidden')
  failedState.classList.add('hidden')
  document.getElementById('loading-company').textContent = company || 'Loading…'
  document.getElementById('loading-role').textContent    = role    || ''
  switchTab('assess')
}

// Extraction never found a job page, or auto-apply couldn't finish on its
// own — show what we know plus a manual "I Applied" fallback so a job the
// user finished by hand still gets logged instead of vanishing silently.
function showFailed(payload) {
  _currentJob = payload
  idleState.classList.add('hidden')
  loadingState.classList.add('hidden')
  resultState.classList.add('hidden')
  failedState.classList.remove('hidden')

  document.getElementById('failed-company').textContent = payload.company || ''
  document.getElementById('failed-role').textContent    = payload.title   || ''
  document.getElementById('failed-reason').textContent  = payload.reason  || 'Auto-apply did not finish'

  assessBadge.textContent = '!'
  assessBadge.classList.remove('hidden')
  switchTab('assess')

  chrome.notifications?.create({
    type:    'basic',
    iconUrl: '../assets/icons/icon-48.png',
    title:   `⚠ Needs attention — ${payload.company || 'Job'}`,
    message: payload.reason || 'Auto-apply did not finish',
  })
}

function showResult(payload) {
  idleState.classList.add('hidden')
  loadingState.classList.add('hidden')
  resultState.classList.remove('hidden')
  failedState.classList.add('hidden')

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

// ── Failed-state buttons ────────────────────────────────────────────────────
// There's no content-script action to route these through — extraction/
// auto-apply already gave up on this page — so log directly rather than
// going through GH_DO_APPLY/GH_DO_SKIP (which target the ATS tab).

document.getElementById('btn-failed-applied').addEventListener('click', () => {
  if (!_currentJob) return
  chrome.runtime.sendMessage({
    type: MSG.LOG_APPLICATION,
    payload: {
      site:     'github',
      company:  _currentJob.company,
      role:     _currentJob.title || _currentJob.role || '',
      url:      _currentJob.url,
      sourceRepo: _currentJob.sourceRepo,
      decision: 'APPLIED',
      reason:   'Manually applied after auto-apply could not finish',
    },
  })
  addLog(`✓ Marked applied — ${_currentJob.company} · ${_currentJob.title || _currentJob.role || ''}`, 'success')
  showIdle()
})

document.getElementById('btn-failed-skip').addEventListener('click', async () => {
  if (!_currentJob) return
  const entry = {
    company:    _currentJob.company,
    title:      _currentJob.title || _currentJob.role || '',
    url:        _currentJob.url,
    sourceRepo: _currentJob.sourceRepo,
    reason:     _currentJob.reason || 'Auto-apply did not finish',
  }
  // Mark seen now so the batch queue / GitHub row highlighting doesn't keep
  // reopening this same page — it's parked in Review until resolved by hand.
  if (entry.url) await addSeenJob(entry.url)
  await addNeedsAttention(entry)
  refreshReview()
  addLog(`↻ Needs review — ${entry.company} · ${entry.title}`, 'skip')
  showIdle()
})

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {

  // ── Queue status ────────────────────────────────────────────────────────
  if (msg.type === MSG.QUEUE_START) {
    const { total } = msg.payload || {}
    _queueActive = true
    setQueuePauseBtn(false)
    renderSources()
    showQueueStrip(0, total || 0)
    addLog(`Queue started — ${total} jobs to process`, 'system')
    switchTab('log')
  }

  if (msg.type === MSG.QUEUE_PROGRESS) {
    const { done, total } = msg.payload || {}
    showQueueStrip(done, total)
  }

  if (msg.type === MSG.QUEUE_DONE) {
    const { done, total } = msg.payload || {}
    _queueActive = false
    renderSources()
    doneQueueStrip(done, total)
    addLog(`Queue complete — ${done} / ${total} processed`, 'success')
  }

  if (msg.type === MSG.QUEUE_PAUSED) {
    const { paused } = msg.payload || {}
    setQueuePauseBtn(paused)
    queueLabel.textContent = paused ? '⏸ Paused' : '⏳ Queue'
    queueLabel.style.color = paused ? '#f59e0b' : '#818cf8'
    queueFill.style.background = paused ? '#f59e0b' : '#6366f1'
    addLog(paused ? 'Queue paused — no new jobs will open' : 'Queue resumed', 'system')
  }

  // ── Known source tabs changed ────────────────────────────────────────────
  if (msg.type === MSG.SOURCES_UPDATED) {
    renderSources(msg.payload?.sources)
  }

  if (msg.type === MSG.LOG_APPLICATION) {
    const { company, role, decision, reason, scoreLabel } = msg.payload || {}
    const tag = decision === 'APPLIED' ? 'success' : 'skip'
    const icon = decision === 'APPLIED' ? '✓' : '→'
    const label = scoreLabel ? ` [${scoreLabel}]` : ''
    const why   = reason ? ` — ${reason.slice(0, 70)}` : ''
    addLog(`${icon} ${decision} — ${company || '?'} · ${role || ''}${label}${why}`, tag)
  }

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

  // Extraction never found a job page (custom career site / two-step ATS
  // flow that hid the form) — show the Failed state with a manual override.
  if (msg.type === MSG.GH_ASSESS_FAILED) {
    showFailed(msg.payload || {})
    addLog(`⚠ Couldn't assess — ${msg.payload?.company || '?'}: ${msg.payload?.reason || ''}`, 'warn')
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
  if (msg.type === MSG.AUTO_APPLY_FAILED) {
    addLog(`⚠ Apply failed — ${msg.payload?.company || 'company'}`, 'warn')
    showFailed({
      title:    msg.payload?.role,
      company:  msg.payload?.company,
      url:      msg.payload?.url,
      sourceRepo: msg.payload?.sourceRepo,
      reason:   'Auto-apply could not fill or submit this form',
    })
  }

  // Fill log from form filler
  if (msg.type === MSG.FILL_LOG) {
    const { label, status, severity, text } = msg.payload || {}
    if (status === 'filled')   addLog(`Filled: ${capitalize(label)}`, 'fill')
    if (status === 'uploaded') addLog('Resume uploaded', 'fill')
    if (status === 'unknown')  addLog(`? Unknown field: ${label}`, 'claude')
    // Free-text diagnostic messages (warnings from the apply/click pipeline,
    // scan-my-answers results, etc.) — previously silently dropped here.
    if (text) addLog(text, severity === 'warn' ? 'warn' : 'info')
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
