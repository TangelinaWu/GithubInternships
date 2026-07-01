// Ashby ATS handler
// Job listing URL : jobs.ashbyhq.com/{org}/{jobId}
// Application URL : jobs.ashbyhq.com/{org}/{jobId}/application

window.__jaHandler = {
  detectionRules: {
    urlPatterns: [/ashbyhq\.com/i],
    selectors: ['form', '[class*="ApplicationForm"]', '[data-testid*="application"]'],
  },

  _paused: false,

  pause() {
    this._paused = true
  },

  async run(profile, onUnknown) {
    this._paused = false
    floatingButton.setState(floatingButton.STATES.RUNNING)

    try {
      await this._fillForm(profile, onUnknown)
    } catch (err) {
      console.error('[JobApplier] Ashby error:', err)
      floatingButton.setState(floatingButton.STATES.ERROR)
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: `⚠ Ashby error: ${err.message}` },
      }).catch(() => {})
    }
  },

  async _fillForm(profile, onUnknown) {
    // Ashby renders the application form at /application sub-path.
    // If we're still on the listing page (no form), bail — clickIntermediateApplyIfNeeded
    // will navigate us to the right URL and main.js will re-run.
    const form = document.querySelector('form')
    if (!form) {
      floatingButton.setState(floatingButton.STATES.ERROR)
      chrome.runtime.sendMessage({
        type: MSG.FILL_LOG,
        payload: { severity: 'warn', text: '⚠ Ashby: application form not found on this page' },
      }).catch(() => {})
      return
    }

    floatingButton.setProgress('Uploading resume…')
    chrome.runtime.sendMessage({ type: MSG.FILL_LOG, payload: { label: 'Resume', status: 'uploading' } }).catch(() => {})

    await this._handleResumeUpload(form, profile)

    chrome.runtime.sendMessage({ type: MSG.FILL_LOG, payload: { label: 'Resume', status: 'uploaded' } }).catch(() => {})

    floatingButton.setProgress('Filling form…')

    formScanner.report({
      site:    'ashby',
      company: this._companyFromPage(),
      role:    document.querySelector('h1')?.textContent.trim() || document.title,
      url:     window.location.href,
      fields:  formScanner.scan(form),
    })

    await formFiller.fillContainer(form, profile, onUnknown)

    if (this._paused) {
      floatingButton.setState(floatingButton.STATES.PAUSED)
      return
    }

    floatingButton.setState(floatingButton.STATES.DONE)
    floatingButton.setProgress('Review & submit')

    if (profile.autoSubmit) {
      await humanDelay.beforeClick()
      const submitBtn =
        form.querySelector('button[type="submit"]') ||
        form.querySelector('input[type="submit"]') ||
        [...form.querySelectorAll('button')].find(b => /submit|apply/i.test(b.textContent))
      if (submitBtn) submitBtn.click()
    }

    this._logApplication()
  },

  async _handleResumeUpload(form, profile) {
    if (!profile.resumeDataUrl) return

    const scopes = [form, document]
    let fileInput = null
    for (const scope of scopes) {
      fileInput =
        scope.querySelector('input[type="file"][name*="resume"]') ||
        scope.querySelector('input[type="file"][name*="cv"]') ||
        scope.querySelector('input[type="file"][accept*="pdf"]') ||
        scope.querySelector('input[type="file"]')
      if (fileInput) break
    }

    if (fileInput) {
      await formFiller.fillFileInput(fileInput, profile.resumeDataUrl, profile.resumeFileName)
      await humanDelay.betweenFields()
    }
  },

  _companyFromPage() {
    // Ashby page title is usually "{Company} - {Role}" or "{Role} at {Company}"
    const t = document.title
    if (t.includes(' at ')) return t.split(' at ').slice(-1)[0].trim()
    if (t.includes(' - '))  return t.split(' - ')[0].trim()
    return window.location.pathname.split('/')[1] || ''
  },

  _logApplication() {
    chrome.runtime.sendMessage({
      type: MSG.LOG_APPLICATION,
      payload: {
        site:    'ashby',
        company: this._companyFromPage(),
        role:    document.querySelector('h1')?.textContent.trim() || document.title,
        url:     window.location.href,
      },
    }).catch(() => {})
  },
}
