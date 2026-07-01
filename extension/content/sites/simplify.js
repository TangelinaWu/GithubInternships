// Simplify.jobs handler
// clickIntermediateApplyIfNeeded in main.js clicks the "Easy Apply" button.
// Two outcomes:
//   1. Same-page form appears  → run() fills it here on Simplify
//   2. Page navigates to ATS   → pendingAutoApply stays in storage; the ATS
//                                 page's init() picks it up and fills the form

window.__jaHandler = {
  detectionRules: {
    urlPatterns: [/simplify\.jobs/i],
    selectors: [
      'form input:not([type="hidden"])',
      '[class*="ApplicationForm"]',
      '[class*="apply-form"]',
      '[data-testid*="application"]',
    ],
  },

  _paused: false,

  pause() { this._paused = true },

  async run(profile, onUnknown) {
    this._paused = false
    floatingButton.setState(floatingButton.STATES.RUNNING)

    try {
      const form = document.querySelector('form')
      if (!form) {
        floatingButton.setState(floatingButton.STATES.DONE)
        floatingButton.setProgress('Review & submit')
        return
      }

      floatingButton.setProgress('Filling form…')
      await formFiller.fillContainer(form, profile, onUnknown)

      if (this._paused) {
        floatingButton.setState(floatingButton.STATES.PAUSED)
        return
      }

      floatingButton.setState(floatingButton.STATES.DONE)
      floatingButton.setProgress('Review & submit')

      chrome.runtime.sendMessage({
        type: MSG.LOG_APPLICATION,
        payload: {
          site:    'simplify',
          company: document.querySelector('h2, [class*="company"], [class*="employer"]')?.textContent.trim() || '',
          role:    document.querySelector('h1')?.textContent.trim() || document.title,
          url:     window.location.href,
        },
      }).catch(() => {})
    } catch (err) {
      console.error('[GHI] Simplify error:', err)
      floatingButton.setState(floatingButton.STATES.ERROR)
    }
  },
}
