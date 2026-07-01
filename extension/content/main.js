// Entry point for all content script bundles.
// Each sites/*.js file sets window.__jaHandler before this file runs.
// This file orchestrates detection, profile loading, and button mounting.

(function () {
  "use strict";

  // Intercept SPA navigation (history.pushState) so we re-run on LinkedIn/Handshake
  // when the user navigates to a new job without a full page reload.
  const _origPushState = history.pushState;
  history.pushState = function (...args) {
    _origPushState.apply(this, args);
    window.dispatchEvent(new Event("ja:locationchange"));
  };
  const _origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    _origReplaceState.apply(this, args);
    window.dispatchEvent(new Event("ja:locationchange"));
  };
  window.addEventListener("popstate", () =>
    window.dispatchEvent(new Event("ja:locationchange"))
  );

  let initialized = false;

  // Open a URL as a genuine new tab/window via window.open, retrying up to 4
  // times if the browser reports a blocked/failed popup — but stopping the
  // instant one succeeds so we never spawn duplicates. Deliberately NOT
  // routed through chrome.tabs.create: that extension API doesn't reliably
  // produce a visible window in the Electron shell this runs in, while
  // window.open does (it's wired straight into the app's window-open handling).
  function openUrlAsNewTab(url) {
    for (let i = 0; i < 4; i++) {
      try {
        if (window.open(url, "_blank", "noopener")) return true;
      } catch {
        // fall through and retry
      }
    }
    return false;
  }

  // Shared callback used by both auto-apply and manual paths.
  async function onUnknown(element, labelText) {
    const context = element.closest("form")
      ? element.closest("form").textContent.slice(0, 300)
      : "";
    const result = await overlayManager.ask(labelText, context);
    if (result.accepted && result.value) {
      formFiller.setInputValue(element, result.value);
      return "filled";
    }
    return "skipped";
  }

  async function init() {
    const handler = window.__jaHandler;
    if (!handler) return;

    // Auto-apply: check BEFORE form detection so intermediate "Apply" buttons
    // on landing pages (which hide the form until clicked) are handled correctly.
    // The previous code placed this after isDetected, so it never ran when the
    // form wasn't yet visible — the most common case on ATS landing pages.
    if (!window.location.hostname.includes('linkedin.com') && !initialized) {
      const { pendingAutoApply } = await new Promise(r =>
        chrome.storage.local.get('pendingAutoApply', r)
      );
      if (pendingAutoApply) {
        initialized = true;
        const jobInfo = pendingAutoApply;
        chrome.runtime.sendMessage({ type: MSG.AUTO_APPLY_FILLING, payload: jobInfo }).catch(() => {});

        // Click any intermediate "Apply" button.
        // If it opened a new tab (returns true), pendingAutoApply stays in storage
        // for that tab's init() to pick up — nothing more to do here.
        const openedNewTab = await clickIntermediateApplyIfNeeded();
        if (openedNewTab) return;

        chrome.storage.local.remove('pendingAutoApply');

        const profile = await getProfile();
        handler.run(profile, onUnknown).then(() => {
          reportAutoApplyOutcome(jobInfo);
        });
        return;
      }
    }

    // Manual mode: detect the form and mount the floating "Fill Form" button.
    const isDetected = detector.detect(handler.detectionRules);

    if (!isDetected) {
      // Watch for the form to appear (SPA lazy render)
      detector.watchForForm(handler.detectionRules, () => {
        if (!initialized) init();
      });
      return;
    }

    if (initialized) return;
    initialized = true;

    floatingButton.mount({
      // Load profile fresh on each click — ensures credentials seeded after page
      // load (or reloaded via the menu) are always used.
      onStart: async () => {
        const profile = await getProfile();
        return handler.run(profile, onUnknown);
      },
      onPause: () => handler.pause(),
      idleLabel: handler.idleLabel || null,
      // Scan whatever the user has manually typed into this form and ask
      // Claude to turn it into reusable answers.json entries — lets manual
      // fills teach the auto-fill pipeline instead of only the AI-overlay path.
      onScan: async () => {
        const form = document.querySelector("form");
        if (!form) return { label: "⚠ No form found" };

        const fields = formScanner.scanValues(form);
        if (fields.length === 0) return { label: "⚠ Nothing filled in" };

        chrome.runtime.sendMessage({
          type: MSG.FILL_LOG,
          payload: { text: `⏳ Scanning ${fields.length} answers…` },
        }).catch(() => {});

        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: MSG.SCAN_ANSWERS, payload: { fields } }, resolve);
        });

        if (!resp || resp.error) {
          const errText = resp?.error || "no response";
          chrome.runtime.sendMessage({
            type: MSG.FILL_LOG,
            payload: { severity: "warn", text: `⚠ Answer scan failed: ${errText}` },
          }).catch(() => {});
          return { label: `⚠ ${errText}` };
        }

        chrome.runtime.sendMessage({
          type: MSG.FILL_LOG,
          payload: { text: `✓ Saved ${resp.saved} answers to answers.json` },
        }).catch(() => {});
        return { label: `✓ Saved ${resp.saved}` };
      },
    });
  }

  // Known Apply-button selectors per ATS — the button markup differs a lot
  // site to site, so try these first before falling back to fuzzy text match.
  const SITE_APPLY_SELECTORS = {
    'greenhouse.io':     ['#apply_button', 'a[href="#app"]', '.postings-btn', 'button[id*="apply" i]'],
    'lever.co':          ['.postings-btn', 'a.postings-btn', '.template-btn-submit'],
    'myworkdayjobs.com': ['[data-automation-id="applyButton"]', '[data-automation-id="adventureButton"]', 'button[data-automation-id*="apply" i]'],
    'ashbyhq.com':       ['a[href*="/application"]', 'button[class*="apply" i]', '[data-testid*="apply" i]'],
    'joinhandshake.com': ['button[class*="apply" i]', '[data-hook*="apply" i]'],
    'simplify.jobs':     ['button[class*="apply" i]', 'a[class*="apply" i]', 'button[class*="easy" i]'],
  };

  // Find the "Apply" CTA and open the application form in a new tab.
  // Returns true  → new tab was opened; caller must NOT remove pendingAutoApply
  //                  (the new tab's init() will read it from storage and fill the form).
  // Returns false → form is already on this page; caller handles it normally.
  async function clickIntermediateApplyIfNeeded() {
    const FORM_SEL = 'form input:not([type="hidden"]), form select, form textarea';
    if (document.querySelector(FORM_SEL)) return false;

    function getVisibleText(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function isVisible(el) {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    // Fuzzy fallback — short text containing an apply-ish phrase. Not anchored
    // (^...$) so it tolerates trailing punctuation/icons/extra whitespace that
    // differ between sites, but capped at 40 chars so body copy never matches.
    function looksLikeApplyText(text) {
      if (!text || text.length > 40) return false;
      return /(easy\s+apply|quick\s+apply|apply\s*(now|here)?|apply\s+(for|to)\s+(this\s+)?(job|position|role|opening|internship)|submit\s+(your\s+)?application|i.?m\s+interested)/i.test(text);
    }

    function siteSelectors() {
      const host = location.hostname.toLowerCase();
      for (const [domain, sels] of Object.entries(SITE_APPLY_SELECTORS)) {
        if (host.includes(domain)) return sels;
      }
      return [];
    }

    function findCandidates() {
      const seen = new Set();
      const out  = [];
      const add  = (el) => {
        if (!el || seen.has(el) || !isVisible(el)) return;
        seen.add(el);
        out.push(el);
      };

      // Site-specific selectors first — most reliable per ATS.
      siteSelectors().forEach(sel => {
        document.querySelectorAll(sel).forEach(add);
      });
      // Generic fuzzy text match as a fallback for unlisted sites.
      document.querySelectorAll('a[href], button, [role="button"]').forEach(el => {
        if (looksLikeApplyText(getVisibleText(el))) add(el);
      });

      return out;
    }

    // Wait up to 10 s for at least one candidate to appear (ATS pages can be slow SPAs).
    let candidates = [];
    for (let i = 0; i < 20 && candidates.length === 0; i++) {
      candidates = findCandidates();
      if (candidates.length === 0) await new Promise(r => setTimeout(r, 500));
    }

    if (candidates.length === 0) {
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: '⚠ No apply button found — check page manually' },
      }).catch(() => {});
      return false;
    }

    function simulateClick(el) {
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width  / 2);
      const cy = Math.round(rect.top  + rect.height / 2);
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      ['pointerover','pointerenter','mouseover','mouseenter',
       'pointermove','mousemove',
       'pointerdown','mousedown',
       'pointerup',  'mouseup', 'click'].forEach(type => {
        el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, opts));
      });
      el.click();
    }

    function waitForForm(ms) {
      return new Promise(resolve => {
        if (document.querySelector(FORM_SEL)) return resolve(true);
        let done = false;
        const obs = new MutationObserver(() => {
          if (document.querySelector(FORM_SEL)) { obs.disconnect(); done = true; resolve(true); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { if (!done) { obs.disconnect(); resolve(false); } }, ms);
      });
    }

    // Try every candidate, re-scanning for fresh ones across rounds — some
    // ATS "Apply" buttons are decorative and need a different element clicked,
    // some need a second click after a reveal animation, some just navigate.
    for (let round = 0; round < 3; round++) {
      if (round > 0) {
        await new Promise(r => setTimeout(r, 1200));
        candidates = findCandidates();
        if (candidates.length === 0) continue;
      }

      for (const btn of candidates) {
        if (!document.contains(btn) || !isVisible(btn)) continue;

        // Only open a new tab when the button is a genuine cross-page link.
        // btn.href (DOM property) always resolves to a full URL even for href="#",
        // so we also check the raw attribute and that the destination differs.
        const rawHref     = btn.getAttribute('href') || '';
        const resolvedUrl = btn.href || '';
        const isCrossPage = resolvedUrl.startsWith('http') &&
          resolvedUrl.replace(/#.*$/, '') !== window.location.href.replace(/#.*$/, '') &&
          rawHref !== '#' && !rawHref.startsWith('javascript:');

        if (isCrossPage) {
          // Open in a new tab — pendingAutoApply stays in storage so the new
          // tab's init() picks it up and fills the form there.
          openUrlAsNewTab(resolvedUrl);
          return true;  // new tab opened — caller should NOT remove pendingAutoApply
        }

        // Click twice — some buttons only register the click after a reveal
        // animation finishes, so a single click can silently no-op.
        simulateClick(btn);
        await new Promise(r => setTimeout(r, 400));
        simulateClick(btn);

        if (await waitForForm(2500)) return false;
      }
    }

    chrome.runtime.sendMessage({
      type: MSG.FILL_LOG,
      payload: { severity: 'warn', text: '⚠ Form not found after clicking apply — may need manual submission' },
    }).catch(() => {});
    return false;
  }

  // A form-fill run can silently swallow its own errors (each site handler
  // catches internally so a thrown error doesn't crash the pipeline) —  the
  // only externally-visible trace is the button being left in ERROR state.
  // Check that before reporting success, so a failed apply is reported as
  // failed instead of complete.
  function reportAutoApplyOutcome(jobInfo) {
    const failed = floatingButton.getState() === floatingButton.STATES.ERROR;
    chrome.runtime.sendMessage({
      type: failed ? MSG.AUTO_APPLY_FAILED : MSG.AUTO_APPLY_COMPLETE,
      payload: { ...jobInfo, atsUrl: window.location.href },
    }).catch(() => {});
  }

  // Called by ats-assessor.js after it sets pendingAutoApply — runs auto-fill without a page reload
  window._ghiTriggerAutoFill = async () => {
    const handler = window.__jaHandler;
    if (!handler) return;
    const { pendingAutoApply: jobInfo } = await new Promise(r =>
      chrome.storage.local.get('pendingAutoApply', r)
    );
    if (!jobInfo) return;
    initialized = true;
    chrome.runtime.sendMessage({ type: MSG.AUTO_APPLY_FILLING, payload: jobInfo }).catch(() => {});
    // If a new tab was opened for the form, pendingAutoApply stays in storage
    // so that tab's init() can pick it up. Nothing more to do in this context.
    const openedNewTab = await clickIntermediateApplyIfNeeded();
    if (openedNewTab) return;
    chrome.storage.local.remove('pendingAutoApply');
    const profile = await getProfile();
    handler.run(profile, onUnknown).then(() => {
      reportAutoApplyOutcome(jobInfo);
    });
  };

  // Exposed so ats-assessor.js can try clicking through an intermediate
  // "Apply" button during the initial fit-check extraction pass too — not
  // just after Claude has already approved the job. Custom career sites and
  // two-step ATS flows (Workday, Ashby) often hide the real job description
  // and form behind this click, which otherwise looks like a silent stall.
  window._ghiClickIntermediateApply = clickIntermediateApplyIfNeeded;

  // Re-initialize on SPA navigation
  window.addEventListener("ja:locationchange", () => {
    initialized = false;
    // Give the SPA a moment to render the new page before we check
    setTimeout(init, 600);
  });

  // Initial run
  init();
})();
