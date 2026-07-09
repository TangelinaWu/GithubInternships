// ATS Assessor — runs on any ATS page (Greenhouse, Lever, Workday, Simplify, etc.)
// Extracts job title, company, and description, then calls Claude for a fit check.
// Result is shown in the control panel; user clicks Apply or Skip.

;(async () => {
  function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

  // Best-effort: tailors the master resume to this job description and swaps
  // it in as the active resume (via background.js → local server → resumes/),
  // mirroring JobApplier's job_automation linkedin.js _tailorResume. Never
  // blocks or fails the apply flow — falls back to whatever resume is already
  // configured if tailoring times out or errors.
  async function tailorResumeBeforeApply(title, company, fullDescription) {
    if (!fullDescription) return
    try {
      const result = await chrome.runtime.sendMessage({
        type: MSG.TAILOR_RESUME,
        payload: { jobDescription: fullDescription, jobTitle: title || '', company: company || '' },
      })
      if (result?.error) {
        chrome.runtime.sendMessage({
          type: MSG.FILL_LOG,
          payload: { label: 'Resume tailoring skipped', status: result.error, text: `Resume tailoring skipped (${result.error})`, severity: 'warn' },
        }).catch(() => {})
      } else if (result?.fileName) {
        chrome.runtime.sendMessage({
          type: MSG.FILL_LOG,
          payload: { label: 'Resume tailored', status: `${result.fileName} (fit ${result.fitScore ?? '?'}%)`, text: `Resume tailored — ${result.fileName} (fit ${result.fitScore ?? '?'}%)` },
        }).catch(() => {})
      }
    } catch (e) {
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { label: 'Resume tailoring failed', status: e.message, text: `Resume tailoring failed: ${e.message}`, severity: 'warn' },
      }).catch(() => {})
    }
  }

  // ── Description extraction (universal — no per-ATS selectors) ────────────
  //
  // Every internship listing links to a different ATS with its own HTML, so
  // hunting for the right CSS selector per platform is a losing game (that's
  // exactly what broke on Rippling's ATS). Instead, select the entire page's
  // visible text the way a person would — a real text selection that
  // visibly highlights sweeping over the page — and hand that whole blob to
  // Claude rather than trying to isolate "the description container."

  function selectAllPageText() {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(document.body)
    selection.removeAllRanges()
    selection.addRange(range)
    const text = selection.toString()
    selection.removeAllRanges()
    return text
  }

  // A long selected-text blob alone isn't a safe enough signal that this is
  // actually a job page (this runs on every site now, not just known ATS
  // platforms) — news articles, docs, wikis would all match. Require either
  // a real application form or explicit apply/job-posting language nearby.
  function looksLikeJobPage() {
    const hasApplicationForm = !!document.querySelector(
      'form input[type="email"], form input[type="file"], form input[name*="resume" i]'
    )
    const jobPageRe  = /\b(apply now|submit application|job description|responsibilities|qualifications)\b/i
    const bodySample = document.body?.innerText?.slice(0, 3000) || ''
    return hasApplicationForm || jobPageRe.test(bodySample) || jobPageRe.test(document.title)
  }

  // Workday (and similar SPA) postings render short facet headings — job
  // level ("Undergraduate"), employment type ("Intern"), locations, etc. —
  // as h1/h2 elements above or alongside the real job title. Blindly taking
  // the first h1/h2 grabs one of those instead of the title. Filter them out
  // by word and by length, then prefer the longest remaining heading (the
  // actual title is reliably the most descriptive text on the page).
  const FACET_WORDS = new Set([
    'intern', 'internship', 'co-op', 'coop', 'undergraduate', 'graduate',
    'entry level', 'entry-level', 'full time', 'full-time', 'part time',
    'part-time', 'contract', 'temporary', 'remote', 'hybrid', 'onsite',
    'on-site', 'senior', 'junior', 'associate', 'mid level', 'mid-level',
  ])

  function looksLikeRealHeading(text) {
    return !!text && text.length >= 8 && !FACET_WORDS.has(text.toLowerCase())
  }

  function pickHeading() {
    const candidates = [...document.querySelectorAll('h1, h2')]
      .map(el => el.textContent.trim())
      .filter(looksLikeRealHeading)
      .sort((a, b) => b.length - a.length)
    return candidates[0] || ''
  }

  // Most ATS platforms encode the company in the URL rather than the DOM —
  // Workday: {company}.wdN.myworkdayjobs.com, Lever: jobs.lever.co/{company},
  // Greenhouse: job-boards.greenhouse.io/{company}, iCIMS: {company}.icims.com.
  // Used as a fallback when title-parsing yields a facet word instead of a
  // real company name (the failure mode above, applied to document.title).
  function companyFromUrl() {
    const host        = location.hostname
    const sub         = host.split('.')[0]
    const genericSubs = new Set(['jobs', 'boards', 'job-boards', 'www', 'apply', 'careers', 'app'])
    const slug        = genericSubs.has(sub) ? location.pathname.split('/').filter(Boolean)[0] : sub
    if (!slug) return host
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }

  function extractJobInfo() {
    const t       = document.title
    const title   = pickHeading() || t.trim()
    let company   = t.includes(' at ') ? t.split(' at ').slice(-1)[0].trim()
                  : t.includes(' - ')  ? t.split(' - ')[0].trim()
                  : ''
    if (!company || FACET_WORDS.has(company.toLowerCase())) company = companyFromUrl()

    if (!looksLikeJobPage()) return { title, company, desc: '' }

    return { title, company, desc: selectAllPageText() }
  }

  // Scroll to the bottom and back before reading the DOM — custom career
  // sites and SPA ATS platforms often lazy-render the description (or the
  // rest of the page) only once it's scrolled into view, so a page that
  // looks empty on load can still have real content just below the fold.
  function scrollToBottomAndBack() {
    return new Promise(resolve => {
      const startY = window.scrollY
      window.scrollTo(0, document.body.scrollHeight)
      setTimeout(() => {
        window.scrollTo(0, startY)
        setTimeout(resolve, 150)
      }, 350)
    })
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

  // Wait for page to fully render (especially SPAs like Workday).
  // Retry extraction up to 4 times with growing delays — ATS portals often
  // inject the job description asynchronously after the initial HTML loads.
  let title, company, desc
  for (let attempt = 0; attempt < 4; attempt++) {
    await wait(attempt === 0 ? 2500 : 2000)
    await scrollToBottomAndBack()
    ;({ title, company, desc } = extractJobInfo())
    const descReady = desc && desc.length >= 100
    // The description often loads before the header does (seen on Workday) —
    // keep retrying so we don't lock in a placeholder/facet heading while
    // attempts remain, but don't hold up an otherwise-ready assessment forever.
    if (descReady && (looksLikeRealHeading(title) || attempt === 3)) break
  }

  // Still nothing — the real description/form is likely hidden behind an
  // intermediate "Apply" button (common on custom company career sites and
  // two-step ATS flows like Workday/Ashby). main.js already has click-through
  // logic for the post-approval auto-fill path; reuse it here as a last
  // resort before giving up on extraction entirely.
  if ((!desc || desc.length < 100) && typeof window._ghiClickIntermediateApply === 'function') {
    const openedNewTab = await window._ghiClickIntermediateApply().catch(() => false)
    if (openedNewTab) return   // real content will be assessed in the new tab
    await wait(1500)
    await scrollToBottomAndBack()
    ;({ title, company, desc } = extractJobInfo())
  }

  const url        = location.href
  const sourceRepo = await getSourceRepo()

  if (!desc || desc.length < 100) {
    // Still nothing — surface this as a Failed state instead of a silent
    // stall, so the control panel shows it and the user can mark it applied
    // manually after finishing the application by hand.
    chrome.runtime.sendMessage({
      type: MSG.GH_ASSESS_FAILED,
      payload: {
        title:      title   || document.title || '(unknown role)',
        company:    company || new URL(url).hostname,
        url, sourceRepo,
        reason: 'Could not find a job description or application form on this page',
      },
    }).catch(() => {})
    return
  }

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

  // Auto-decide based on Claude's response
  if (fitResult?.error && !fitResult?.decision) {
    // Error from Claude — fall back to manual control panel buttons
    chrome.runtime.onMessage.addListener(function handler(msg) {
      if (msg.type !== MSG.GH_DO_APPLY && msg.type !== MSG.GH_DO_SKIP) return
      chrome.runtime.onMessage.removeListener(handler)

      if (msg.type === MSG.GH_DO_APPLY) {
        tailorResumeBeforeApply(title, company, desc).then(() => {
          chrome.storage.local.set({
            pendingAutoApply: {
              company: company || new URL(url).hostname,
              role:    title   || '',
              url, sourceRepo,
              description: desc.slice(0, 600),
              score:       fitResult?.score,
              scoreLabel:  fitResult?.scoreLabel,
              matching:    fitResult?.matching || [],
              missing:     fitResult?.missing  || [],
            },
          }, () => {
            fetch('http://127.0.0.1:3743/physical-click', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ url: location.href }),
            })
              .then(r => r.json())
              .then(result => { if (!result.clicked && typeof window._ghiTriggerAutoFill === 'function') window._ghiTriggerAutoFill() })
              .catch(() => { if (typeof window._ghiTriggerAutoFill === 'function') window._ghiTriggerAutoFill() })
          })
        })
      }

      if (msg.type === MSG.GH_DO_SKIP) {
        chrome.runtime.sendMessage({
          type: MSG.LOG_APPLICATION,
          payload: {
            site: 'github', company: company || new URL(url).hostname,
            role: title || '', url, sourceRepo, decision: 'SKIPPED',
            reason: msg.payload?.reason || 'User skipped',
            description: desc.slice(0, 200),
            score: fitResult?.score, scoreLabel: fitResult?.scoreLabel,
          },
        }).catch(() => {})
      }
    })
  } else if (fitResult?.decision === 'YES') {
    // Claude says apply — tailor the resume to this job description first (best
    // effort; swaps in as the active resume before the ATS form's file-upload
    // step runs), then request a physical OS-level click on the Apply button,
    // then fill the form after the page navigates. Fall back to JS click if the
    // Electron server is unavailable.
    await tailorResumeBeforeApply(title, company, desc)
    chrome.storage.local.set({
      pendingAutoApply: {
        company: company || new URL(url).hostname,
        role:    title   || '',
        url, sourceRepo,
        description: desc.slice(0, 600),
        score:       fitResult.score,
        scoreLabel:  fitResult.scoreLabel,
        matching:    fitResult.matching || [],
        missing:     fitResult.missing  || [],
      },
    }, () => {
      fetch('http://127.0.0.1:3743/physical-click', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: location.href }),
      })
        .then(r => r.json())
        .then(result => {
          // Physical click succeeded — the page will navigate; init() on the
          // form page will pick up pendingAutoApply and fill the form.
          if (!result.clicked) {
            // No Apply button found or Electron couldn't click it — JS fallback
            if (typeof window._ghiTriggerAutoFill === 'function') window._ghiTriggerAutoFill()
          }
        })
        .catch(() => {
          // Electron server not running (e.g. standalone browser) — JS fallback
          if (typeof window._ghiTriggerAutoFill === 'function') window._ghiTriggerAutoFill()
        })
    })
  } else {
    // Claude says skip — log immediately
    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site:        'github',
        company:     company || new URL(url).hostname,
        role:        title   || '',
        url, sourceRepo,
        decision:    'SKIPPED',
        reason:      fitResult?.recommendation || 'Claude said No',
        description: desc.slice(0, 200),
        score:       fitResult?.score,
        scoreLabel:  fitResult?.scoreLabel,
      },
    }).catch(() => {})
  }

  // Form fill completing is NOT logged as Applied here — filling isn't the
  // same as confirming a real submission. The floating "Confirm Applied"
  // button (main.js, mounted with the job's own company/role/url/description)
  // is the only thing that sends LOG_APPLICATION decision: 'APPLIED' for this
  // job now, requiring the user's manual click.
})()
