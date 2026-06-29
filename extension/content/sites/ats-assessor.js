// ATS Assessor — runs on any ATS page (Greenhouse, Lever, Workday, Simplify, etc.)
// Extracts job title, company, and description, then calls Claude for a fit check.
// Result is shown in the control panel; user clicks Apply or Skip.

;(async () => {
  function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

  // ── Description extraction (multi-ATS) ────────────────────────────────────

  function extractJobInfo() {
    const url = location.href

    // Greenhouse
    if (/greenhouse\.io/i.test(url)) {
      const title   = document.querySelector('.app-title, h1.posting-headline, h1')?.textContent.trim()
      const company = document.querySelector('.company-name, .header--cobranded .company-name, [class*="company"]')?.textContent.trim()
                   || document.title.split(' - ').slice(-1)[0]?.trim()
      const desc    = document.querySelector('#content, .job__description, .content')?.textContent.trim()
      return { title, company, desc }
    }

    // Lever
    if (/lever\.co/i.test(url)) {
      const title   = document.querySelector('.posting-headline h2, h2.posting-title, h2')?.textContent.trim()
      const company = document.querySelector('.main-header-text .posting-cateogry, .company-name')?.textContent.trim()
                   || document.title.split(' at ').slice(-1)[0]?.trim()
      const desc    = document.querySelector('.posting-requirements, .section-wrapper, .posting')?.textContent.trim()
      return { title, company, desc }
    }

    // Workday
    if (/myworkdayjobs\.com/i.test(url)) {
      const title   = document.querySelector('[data-automation-id="jobPostingHeader"], h1')?.textContent.trim()
      const company = document.querySelector('[data-automation-id="company-name"]')?.textContent.trim()
                   || document.title.split(' - ').slice(-1)[0]?.trim()
      const desc    = document.querySelector('[data-automation-id="jobPostingDescription"], .wd-content')?.textContent.trim()
      return { title, company, desc }
    }

    // Simplify
    if (/simplify\.jobs/i.test(url)) {
      const title   = document.querySelector('h1, [class*="title"]')?.textContent.trim()
      const company = document.querySelector('[class*="company"], [class*="employer"]')?.textContent.trim()
      const desc    = document.querySelector('[class*="description"], [class*="content"], main')?.textContent.trim()
      return { title, company, desc }
    }

    // Handshake
    if (/joinhandshake\.com/i.test(url)) {
      const title   = document.querySelector('h1, .posting-title')?.textContent.trim()
      const company = document.querySelector('.employer-name, [class*="company"]')?.textContent.trim()
      const desc    = document.querySelector('.job-description, [class*="description"]')?.textContent.trim()
      return { title, company, desc }
    }

    // Generic fallback
    const title   = document.querySelector('h1, h2')?.textContent.trim()
    const company = (document.title.split(' - ')[1] || document.title.split(' at ')[1] || '').trim()
    const desc    = document.querySelector('main, article, [class*="description"], [class*="content"]')?.textContent.trim()
    return { title, company, desc }
  }

  // ── Source repo detection ─────────────────────────────────────────────────

  function getSourceRepo() {
    // Check storage for the last GitHub repo the user navigated from
    return new Promise(resolve => {
      chrome.storage.local.get('ghSourceRepo', ({ ghSourceRepo }) => {
        resolve(ghSourceRepo || 'GitHub')
      })
    })
  }

  // ── Main logic ────────────────────────────────────────────────────────────

  // Wait for page to fully render (especially SPAs like Workday)
  await wait(2500)

  const { title, company, desc } = extractJobInfo()
  if (!desc || desc.length < 100) return   // not a real job page yet

  const url        = location.href
  const sourceRepo = await getSourceRepo()

  // Check if already seen
  const { seenJobUrls } = await chrome.storage.local.get('seenJobUrls')
  const seen = new Set(seenJobUrls || [])
  if (seen.has(url)) {
    // Already applied or skipped — notify control panel silently
    chrome.runtime.sendMessage({
      type: MSG.GH_ASSESSING,
      payload: {
        title, company, url, sourceRepo,
        alreadySeen: true,
      },
    }).catch(() => {})
    return
  }

  // Notify control panel we're starting assessment
  chrome.runtime.sendMessage({
    type: MSG.GH_ASSESSING,
    payload: { title, company, url, sourceRepo, loading: true },
  }).catch(() => {})

  // Request fit check from background (uses Claude API)
  let fitResult
  try {
    fitResult = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: MSG.CHECK_FIT, payload: { jobDescription: desc } },
        (resp) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
          else resolve(resp)
        }
      )
    })
  } catch (e) {
    fitResult = { error: e.message }
  }

  // Send result to control panel
  chrome.runtime.sendMessage({
    type: MSG.FIT_RESULT,
    payload: {
      title:       title || '(unknown role)',
      company:     company || new URL(url).hostname,
      url,
      sourceRepo,
      description: desc.slice(0, 600),
      score:       fitResult?.score,
      scoreLabel:  fitResult?.scoreLabel,
      matching:    fitResult?.matching || [],
      missing:     fitResult?.missing  || [],
      recommendation: fitResult?.recommendation || fitResult?.error || 'No response',
    },
  }).catch(() => {})

  // Listen for Apply/Skip decision from control panel
  chrome.runtime.onMessage.addListener(function handler(msg) {
    if (msg.type !== MSG.GH_DO_APPLY && msg.type !== MSG.GH_DO_SKIP) return
    chrome.runtime.onMessage.removeListener(handler)

    if (msg.type === MSG.GH_DO_APPLY) {
      // Log as applied and start form fill (detector.js will handle the form)
      chrome.storage.local.set({
        pendingAutoApply: {
          company: company || new URL(url).hostname,
          role:    title   || '',
          url,
          sourceRepo,
          description: desc.slice(0, 600),
          score:       fitResult?.score,
          scoreLabel:  fitResult?.scoreLabel,
          matching:    fitResult?.matching || [],
          missing:     fitResult?.missing  || [],
        },
      })
    }

    if (msg.type === MSG.GH_DO_SKIP) {
      chrome.runtime.sendMessage({
        type: MSG.LOG_APPLICATION,
        payload: {
          site:        'github',
          company:     company || new URL(url).hostname,
          role:        title   || '',
          url,
          sourceRepo,
          decision:    'SKIPPED',
          reason:      msg.payload?.reason || 'User skipped',
          description: desc.slice(0, 200),
          score:       fitResult?.score,
          scoreLabel:  fitResult?.scoreLabel,
        },
      }).catch(() => {})
    }
  })

  // When form submission is detected (AUTO_APPLY_COMPLETE), log as applied
  chrome.runtime.onMessage.addListener(function applyDoneHandler(msg) {
    if (msg.type !== MSG.AUTO_APPLY_COMPLETE) return
    chrome.runtime.onMessage.removeListener(applyDoneHandler)

    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site:        'github',
        company:     company || new URL(url).hostname,
        role:        title   || '',
        url,
        sourceRepo,
        decision:    'APPLIED',
        description: desc.slice(0, 600),
        score:       fitResult?.score,
        scoreLabel:  fitResult?.scoreLabel,
        matching:    fitResult?.matching || [],
        missing:     fitResult?.missing  || [],
      },
    }).catch(() => {})
  })
})()
