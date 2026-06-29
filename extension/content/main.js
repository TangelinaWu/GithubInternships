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
        chrome.storage.local.remove('pendingAutoApply');
        chrome.runtime.sendMessage({ type: MSG.AUTO_APPLY_FILLING, payload: jobInfo }).catch(() => {});

        // Click any intermediate "Apply" button and wait for the real form to appear.
        await clickIntermediateApplyIfNeeded();

        const profile = await getProfile();
        handler.run(profile, onUnknown).then(() => {
          chrome.runtime.sendMessage({
            type: MSG.AUTO_APPLY_COMPLETE,
            payload: { ...jobInfo, atsUrl: window.location.href },
          }).catch(() => {});
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
    });
  }

  // If no application form is visible yet, look for an intermediate "Apply" button
  // (e.g. "Apply to this job", "Apply now") and click it, then wait for the form.
  async function clickIntermediateApplyIfNeeded() {
    // If a form with fillable inputs is already present, nothing to do.
    if (document.querySelector('form input:not([type="hidden"]), form select, form textarea')) return;

    const APPLY_RE = /^(apply(\s+(to\s+)?(this\s+)?(job|position|role|opening|now))?|apply\s+now)$/i;

    function findBtn() {
      return [...document.querySelectorAll('a[href], button')].find(el => {
        if (!APPLY_RE.test(el.textContent.trim())) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    }

    // Wait up to 4 s for the button to appear (page may still be loading)
    let btn = null;
    for (let i = 0; i < 8 && !btn; i++) {
      btn = findBtn();
      if (!btn) await new Promise(r => setTimeout(r, 500));
    }

    if (!btn) {
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: '⚠ No apply button found — check page manually' },
      }).catch(() => {});
      return;
    }

    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise(r => setTimeout(r, 300));
    btn.click();

    // Wait up to 5 s for a form with fillable fields to appear
    await new Promise(resolve => {
      const sel = 'form input:not([type="hidden"]), form select, form textarea';
      if (document.querySelector(sel)) return resolve();
      const obs = new MutationObserver(() => {
        if (document.querySelector(sel)) { obs.disconnect(); resolve(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        chrome.runtime.sendMessage({
          type: MSG.FILL_LOG,
          payload: { severity: 'warn', text: '⚠ Form not found after clicking apply — may need manual submission' },
        }).catch(() => {});
        resolve();
      }, 5000);
    });
  }

  // Re-initialize on SPA navigation
  window.addEventListener("ja:locationchange", () => {
    initialized = false;
    // Give the SPA a moment to render the new page before we check
    setTimeout(init, 600);
  });

  // Initial run
  init();
})();
